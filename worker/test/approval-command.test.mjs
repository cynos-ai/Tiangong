import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalOutcomeText,
  approvalPrompt,
  parseApprovalCommand,
} from "../agent/gates/approval-command.mjs";

test("approval commands require an exact deterministic form", () => {
  const id = "approval-0123456789abcdef01234567";
  assert.deepEqual(parseApprovalCommand(`APPROVE ${id}`), { action: "approve", approvalId: id });
  assert.deepEqual(parseApprovalCommand(`REJECT ${id}`), { action: "reject", approvalId: id });
  assert.deepEqual(
    parseApprovalCommand(`@tiangong-worker APPROVE ${id}`),
    { action: "approve", approvalId: id },
  );
  assert.equal(parseApprovalCommand(`please approve ${id}`), undefined);
  assert.deepEqual(
    parseApprovalCommand(`Conversation metadata supplied by the channel host\n\nAPPROVE ${id}`),
    { action: "approve", approvalId: id },
  );
  assert.equal(parseApprovalCommand("APPROVE approval-short"), undefined);
  assert.equal(parseApprovalCommand(`APPROVE ${id}\nREJECT ${id}`), undefined);
});

test("approval prompt is generated from machine operation fields without write content", () => {
  const prompt = approvalPrompt({
    approvalId: "approval-0123456789abcdef01234567",
    operationDigest: "a".repeat(64),
    operation: {
      policyVersion: "workspace-tools-v1",
      workspaceScope: "c".repeat(64),
      toolName: "write",
      target: "output.txt",
      input: { contentDigest: "b".repeat(64), contentBytes: 12 },
    },
  });
  assert.match(prompt, /Policy: workspace-tools-v1/u);
  assert.match(prompt, /Workspace scope: c{64}/u);
  assert.match(prompt, /Tool: write/u);
  assert.match(prompt, /Target: output\.txt/u);
  assert.match(prompt, /APPROVE approval-0123456789abcdef01234567/u);
  assert.equal(prompt.includes("file contents"), false);
  assert.match(approvalPrompt({
    approvalId: "approval-0123456789abcdef01234567",
    operationDigest: "a".repeat(64),
    operation: { policyVersion: "deployment-v1", workspaceScope: "c".repeat(64), toolName: "deploy_release", targetId: "target-1" },
  }), /Target: target-1/u);
});

test("approval outcome text uses the bound target id", () => {
  assert.match(approvalOutcomeText("approve", {
    approvalId: "approval-0123456789abcdef01234567",
    operation: { toolName: "deploy_release", targetId: "target-1" },
  }), /deploy_release target-1\./u);
});
