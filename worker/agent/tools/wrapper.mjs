import {
  idempotencyKey,
  operationDigest,
  operationRequestDigest,
} from "../canonical-json.mjs";
import { assertGateDecision } from "../gates/turn-state.mjs";
import { observabilityOutcome } from "../../observability/tracing.mjs";

export class GateDeniedError extends Error {
  constructor(reason) {
    super(`Tool execution denied: ${reason}`);
    this.name = "GateDeniedError";
    this.code = "TIANGONG_GATE_DENIED";
  }
}

export class ExecutionStateUncertainError extends Error {
  constructor() {
    super("Tool execution state is uncertain; automatic replay is blocked");
    this.name = "ExecutionStateUncertainError";
    this.code = "TIANGONG_EXECUTION_UNCERTAIN";
  }
}

function pendingResult(decision, key, digest) {
  return {
    content: [{
      type: "text",
      text: `Approval required (${decision.approvalId}). Tool execution has not occurred.`,
    }],
    details: {
      gate: "pending",
      approvalId: decision.approvalId,
      idempotencyKey: key,
      operationDigest: digest,
    },
    terminate: true,
  };
}

function evidenceContext(invocation, toolCallId, toolName, digest, key) {
  return {
    sessionId: invocation.sessionId,
    turnId: invocation.turnId,
    actorId: invocation.actor?.id ?? null,
    toolCallId,
    toolName,
    operationDigest: digest,
    idempotencyKey: key,
  };
}

export function createGatedTool({
  definition,
  summarize,
  gate,
  evidence,
  idempotencyStore,
  pendingOperationStore,
  getInvocation,
  sideEffect = false,
  replayResult = (result) => result,
  lifecycle,
}) {
  if (!definition?.name || typeof definition.execute !== "function") {
    throw new TypeError("A tool definition with execute is required");
  }
  for (const [name, value] of Object.entries({ summarize, gate, evidence, getInvocation })) {
    if (!value) throw new TypeError(`${name} is required`);
  }
  if (sideEffect && (!idempotencyStore || !pendingOperationStore)) {
    throw new TypeError("Side-effect tools require idempotency and pending-operation stores");
  }

  return {
    ...definition,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const invocation = getInvocation();
      if (!invocation?.sessionId || !invocation?.turnId || !invocation?.turnState) {
        throw new Error("Tool invocation context is unavailable");
      }
      invocation.observability?.checkpoint("tool.proposed", {
        "tiangong.tool.name": definition.name,
      });

      await evidence.append({
        type: invocation.resumed ? "tool.resumed" : "tool.proposed",
        sessionId: invocation.sessionId,
        turnId: invocation.turnId,
        actorId: invocation.actor?.id ?? null,
        toolCallId,
        toolName: definition.name,
      });

      let operation = await summarize(params);
      const requestDigest = operationRequestDigest(operation);
      let digest = operationDigest(operation);
      let key = idempotencyKey({
        sessionId: invocation.sessionId,
        turnId: invocation.turnId,
        toolCallId,
        operationDigest: digest,
      });
      if (sideEffect) {
        const priorInvocation = await idempotencyStore.findInvocation({
          sessionId: invocation.sessionId,
          turnId: invocation.turnId,
          toolCallId,
        });
        if (priorInvocation) {
          if (priorInvocation.entry.requestDigest !== requestDigest) {
            throw new Error("A repeated tool call changed its requested operation");
          }
          key = priorInvocation.key;
          digest = priorInvocation.entry.operationDigest;
          operation = priorInvocation.entry.operation;
        }
      }
      const common = {
        ...evidenceContext(invocation, toolCallId, definition.name, digest, key),
        requestDigest,
      };

      const priorPending = invocation.turnState.decisionFor(toolCallId);
      const decision = priorPending ?? assertGateDecision(await gate.evaluate({
        ...common,
        operation,
        signal,
      }));

      await evidence.append({
        type: "gate.decided",
        ...common,
        decision: decision.kind,
        operation,
        reasonCode: decision.reasonCode ?? null,
        approvalId: decision.approvalId ?? null,
        blockedByToolCallId: decision.blockedByToolCallId ?? null,
      });
      invocation.observability?.checkpoint("gate.decided", {
        "tiangong.tool.name": definition.name,
        "tiangong.gate.outcome": decision.kind,
        "tiangong.approval.pending": decision.kind === "pending",
      });

      if (decision.kind === "deny") throw new GateDeniedError(decision.reason);
      if (decision.kind === "pending") {
        const checkpoint = {
          ...common,
          operation,
          approvalId: decision.approvalId,
          reason: decision.reason,
          requestedBy: invocation.actor?.id ?? null,
        };
        const suspended = invocation.turnState.suspend(checkpoint);
        if (sideEffect && !priorPending) {
          await pendingOperationStore.put(checkpoint, params);
          await idempotencyStore.putPending(key, checkpoint);
        }
        return pendingResult(
          { ...decision, approvalId: suspended.approvalId },
          suspended.idempotencyKey,
          suspended.operationDigest,
        );
      }

      let prepared;
      if (sideEffect) {
        const begin = await idempotencyStore.beginExecution(key, { ...common, operation });
        if (!begin.execute) {
          if (begin.entry.status === "completed") {
            await evidence.append({ type: "tool.execution.replayed", ...common });
            invocation.observability?.checkpoint("tool.replayed", {
              "tiangong.tool.name": definition.name,
            });
            return structuredClone(begin.entry.replayResult);
          }
          throw new ExecutionStateUncertainError();
        }
      }

      try {
        if (sideEffect) prepared = await lifecycle?.prepare?.({ ...common, operation, params });
        await evidence.append({ type: "tool.execution.started", ...common });
        const execution = invocation.observability?.startOperation("execute_tool", {
          "gen_ai.operation.name": "execute_tool",
          "tiangong.tool.name": definition.name,
        });
        let result;
        try {
          result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
          execution?.end("complete");
        } catch (error) {
          execution?.end(observabilityOutcome(signal), error);
          throw error;
        }
        if (sideEffect) {
          await idempotencyStore.complete(key, {
            operationDigest: digest,
            replayResult: replayResult(result),
          });
        }
        await evidence.append({
          type: "tool.execution.completed",
          ...common,
          status: "success",
        });
        if (sideEffect) {
          try {
            await lifecycle?.commit?.(prepared);
          } catch {
            await evidence.append({ type: "tool.rollback.cleanup_deferred", ...common }).catch(() => {});
          }
          try {
            await pendingOperationStore.remove(key);
          } catch {
            await evidence.append({ type: "operation.payload_cleanup_deferred", ...common }).catch(() => {});
          }
        }
        return result;
      } catch (error) {
        let rollbackError;
        if (sideEffect) {
          try {
            await lifecycle?.rollback?.(prepared);
          } catch (caught) {
            rollbackError = caught;
          }
          await idempotencyStore.fail(key, {
            operationDigest: digest,
            errorCode: rollbackError ? "ROLLBACK_FAILED" : (error?.code ?? "TOOL_EXECUTION_FAILED"),
          });
        }
        await evidence.append({
          type: "tool.execution.completed",
          ...common,
          status: "error",
          errorCode: error?.code ?? "TOOL_EXECUTION_FAILED",
          rollbackStatus: sideEffect ? (rollbackError ? "failed" : "completed") : null,
        });
        if (rollbackError) throw new AggregateError([error, rollbackError], "Tool execution and rollback failed");
        throw error;
      }
    },
  };
}
