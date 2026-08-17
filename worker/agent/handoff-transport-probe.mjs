const HANDOFF_MARKER = /TG_HANDOFF_[A-Z]+/gu;
const HANDOFF_COMMAND = /(?:^|\s)TG_HANDOFF_START\s+work=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\s+intent=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?=[.!?]?\s|[.!?]?$)/gu;
const MATRIX_USER_ID = /^@[A-Za-z0-9._=+\/-]+:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u;
const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MAX_SEEN_TURNS = 64;
const MAX_CONTROL_BYTES = 8192;
const MAX_MARKUP_TAG_BYTES = 512;

function normalizeControlText(text) {
  if (Buffer.byteLength(text) > MAX_CONTROL_BYTES) {
    throw new Error("Specialist handoff control exceeds the bounded input contract");
  }
  return text
    .replace(new RegExp(`<[^>]{1,${MAX_MARKUP_TAG_BYTES}}>` , "gu"), " ")
    .replace(/&(?:nbsp|#160);/giu, " ");
}

function requireMatrixActor(request) {
  if (request?.actor?.channel !== "matrix" ||
      typeof request.actor.id !== "string" || !MATRIX_USER_ID.test(request.actor.id)) {
    throw new Error("Specialist handoff requires an authenticated Matrix actor");
  }
  if (typeof request.actor.messageId !== "string" || !MATRIX_EVENT_ID.test(request.actor.messageId)) {
    throw new Error("Specialist handoff requires the current Matrix event ID");
  }
}

export function parseSpecialistHandoffCommand(text) {
  if (typeof text !== "string") throw new TypeError("Specialist handoff input must be a string");
  const controlText = normalizeControlText(text);
  const markers = [...controlText.matchAll(HANDOFF_MARKER)];
  if (markers.length === 0) return null;
  const commands = [...controlText.matchAll(HANDOFF_COMMAND)];
  if (markers.length !== 1 || commands.length !== 1) {
    throw new Error(`Specialist handoff control is malformed or ambiguous (markers=${markers.length}, commands=${commands.length})`);
  }
  return Object.freeze({
    kind: "start",
    workId: commands[0][1],
    intentId: commands[0][2],
  });
}

export class SpecialistHandoffProbe {
  #planned = new WeakSet();
  #seenTurns = new Set();
  #seenOrder = [];

  hasCommittedTurn(turnId) {
    return typeof turnId === "string" && this.#seenTurns.has(turnId);
  }

  plan(command, request, route) {
    if (!command || command.kind !== "start") throw new TypeError("Specialist handoff command is required");
    requireMatrixActor(request);
    if (request.replyTarget !== null || route?.replyTarget !== null) {
      throw new Error("Specialist handoff must originate from the Human ingress route");
    }
    if (this.#seenTurns.has(request.turnId)) throw new Error("Specialist handoff turn was already consumed");
    if (!Array.isArray(request.authorizedPeerTargets) || request.authorizedPeerTargets.length !== 1) {
      throw new Error("Specialist handoff requires exactly one authorized Leader recipient");
    }
    const recipient = request.authorizedPeerTargets[0];
    if (!recipient || recipient.channel !== "matrix" || typeof recipient.id !== "string" ||
        !MATRIX_USER_ID.test(recipient.id) || recipient.id === request.actor.id) {
      throw new Error("Specialist handoff recipient is not an authenticated peer");
    }
    const plan = Object.freeze({
      turnId: request.turnId,
      workId: command.workId,
      intentId: command.intentId,
      sourceEventId: request.actor.messageId,
      sourceSender: request.actor.id,
      recipient: Object.freeze({ ...recipient }),
    });
    this.#planned.add(plan);
    return plan;
  }

  commit(plan) {
    if (!plan || !this.#planned.has(plan)) throw new TypeError("Specialist handoff plan is invalid or consumed");
    this.#planned.delete(plan);
    this.#seenTurns.add(plan.turnId);
    this.#seenOrder.push(plan.turnId);
    if (this.#seenOrder.length > MAX_SEEN_TURNS) this.#seenTurns.delete(this.#seenOrder.shift());
  }
}
