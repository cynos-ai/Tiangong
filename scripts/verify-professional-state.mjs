#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { EvidenceRecorder } from "../worker/agent/evidence/recorder.mjs";
import { canonicalJson, sha256 } from "../worker/agent/canonical-json.mjs";
import { projectDisposition } from "../worker/agent/team/project-chain.mjs";
import {
  listTaskBindingsForProject,
  readProjectBinding,
  readProjectReport,
  readTaskDecisions,
  readTaskResult,
} from "../worker/agent/team/manifest-store.mjs";
import { isProjectReport, isTaskBinding, verifyContentDigest } from "../worker/agent/team/manifest.mjs";
import { isResultEnvelope } from "../worker/agent/work/result-envelope.mjs";
import {
  assertDecisionResultCompatible,
  assertNextTask,
  assertTaskKindRole,
  reduceTaskChain,
} from "../worker/agent/playbook/transition-policy.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DISPOSITIONS = new Set(["DELIVERED", "FAILED_SAFE", "RECOVERY_REQUIRED"]);

function usage() {
  process.stderr.write("Usage: verify-professional-state.mjs --root <shared-root> --project <project-id> --expected <disposition> [--evidence <file>]...\n");
}

function parseArgs(argv) {
  const values = { evidence: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--root", "--project", "--expected", "--evidence"].includes(flag)) {
      usage();
      throw new Error("VERIFY_ARGUMENTS_INVALID");
    }
    const value = argv[++index];
    if (typeof value !== "string" || value === "") throw new Error("VERIFY_ARGUMENTS_INVALID");
    if (flag === "--evidence") values.evidence.push(value);
    else values[flag.slice(2)] = value;
  }
  if (typeof values.root !== "string" || typeof values.project !== "string" ||
      !ID.test(values.project) || !DISPOSITIONS.has(values.expected) || values.evidence.length > 32) {
    usage();
    throw new Error("VERIFY_ARGUMENTS_INVALID");
  }
  return values;
}

function assertRecord(value, label) {
  if (!verifyContentDigest(value)) throw new Error(`${label}_DIGEST_INVALID`);
}

async function optional(read) {
  try {
    return await read();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function verifyEvidence(filePath) {
  const recorder = new EvidenceRecorder({ filePath });
  const records = await recorder.readAll();
  return {
    fileDigest: sha256(canonicalJson(records)),
    records: records.length,
    terminalSequence: records.at(-1)?.sequence ?? 0,
    terminalHash: records.at(-1)?.hash ?? "0".repeat(64),
  };
}

export async function verifyProfessionalState({ rootDir, projectId, expectedDisposition, evidenceFiles = [] }) {
  const root = await realpath(rootDir);
  const project = await readProjectBinding(projectId, { rootDir: root });
  assertRecord(project, "PROJECT_BINDING");
  const tasks = await listTaskBindingsForProject(projectId, { rootDir: root });
  if (tasks.length === 0) throw new Error("PROJECT_HAS_NO_TASKS");

  const taskReports = [];
  const chain = [];
  for (let index = 1; index < tasks.length; index += 1) {
    if (tasks[index - 1].createdAt === tasks[index].createdAt) throw new Error("TASK_CREATION_ORDER_AMBIGUOUS");
  }
  for (const task of tasks) {
    if (!isTaskBinding(task) || task.projectId !== projectId) throw new Error("TASK_BINDING_INVALID");
    assertTaskKindRole({ taskBinding: task, roleBindings: project.roleBindings });
    assertNextTask({ taskBinding: task, chain, maxRevisionWaves: 2 });
    const result = await optional(() => readTaskResult(task.taskId, { rootDir: root }));
    if (result) {
      if (!isResultEnvelope(result)) throw new Error(`RESULT_INVALID:${task.taskId}`);
      assertRecord(result, `RESULT_${task.taskId}`);
      if (result.taskId !== task.taskId || result.projectId !== projectId ||
          result.revisionIndex !== task.revisionIndex || result.taskKind !== task.taskKind) {
        throw new Error(`RESULT_BINDING_INVALID:${task.taskId}`);
      }
    }
    const decisions = await readTaskDecisions(task.taskId, { rootDir: root });
    if (decisions.length > 1 || decisions.some((decision) => !verifyContentDigest(decision))) {
      throw new Error(`DECISION_CHAIN_INVALID:${task.taskId}`);
    }
    if (decisions[0]) {
      assertDecisionResultCompatible({ decision: decisions[0], taskBinding: task, result });
      chain.push({ taskKind: task.taskKind, decision: decisions[0].decision, revisionIndex: task.revisionIndex });
    }
    taskReports.push({
      taskId: task.taskId,
      taskKind: task.taskKind,
      revisionIndex: task.revisionIndex,
      assignee: task.assignee,
      bindingDigest: task.contentDigest,
      resultDigest: result?.contentDigest ?? null,
      decision: decisions[0]?.decision ?? null,
      decisionDigest: decisions[0]?.contentDigest ?? null,
    });
  }

  const reduced = reduceTaskChain(chain, { maxRevisionWaves: 2 });
  const disposition = await projectDisposition(projectId, { rootDir: root, maxRevisionWaves: 2 });
  if (disposition !== expectedDisposition) throw new Error(`DISPOSITION_MISMATCH:${disposition}`);
  const report = await optional(() => readProjectReport(projectId, { rootDir: root }));
  if (report) {
    if (!isProjectReport(report) || report.projectId !== projectId || report.disposition !== disposition) {
      throw new Error("PROJECT_REPORT_INVALID");
    }
    assertRecord(report, "PROJECT_REPORT");
  }
  const evidence = [];
  for (const filePath of evidenceFiles) evidence.push(await verifyEvidence(filePath));
  return {
    status: "pass",
    projectId,
    projectBindingDigest: project.contentDigest,
    taskCount: tasks.length,
    tasks: taskReports,
    chain: reduced,
    disposition,
    reportDigest: report?.contentDigest ?? null,
    evidence,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await verifyProfessionalState({
      rootDir: args.root,
      projectId: args.project,
      expectedDisposition: args.expected,
      evidenceFiles: args.evidence,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ?? error.message}\n`);
    process.exitCode = 1;
  }
}
