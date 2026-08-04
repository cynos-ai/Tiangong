const APPROVAL_ID = "approval-[0-9a-f]{24}";
const COMMAND = new RegExp(`^(?:@\\S+\\s+)?(APPROVE|REJECT) (${APPROVAL_ID})$`, "u");

export function parseApprovalCommand(prompt) {
  if (typeof prompt !== "string") return undefined;
  const matches = prompt.split(/\r?\n/u)
    .map((line) => COMMAND.exec(line.trim()))
    .filter(Boolean);
  if (matches.length !== 1) return undefined;
  return { action: matches[0][1].toLowerCase(), approvalId: matches[0][2] };
}

export function approvalPrompt(checkpoint) {
  const operation = checkpoint.operation;
  const target = operation.target ?? operation.targetId ?? "bound operation";
  const lines = [
    "Approval required; the tool has not executed.",
    `Approval ID: ${checkpoint.approvalId}`,
    `Policy: ${operation.policyVersion}`,
    `Workspace scope: ${operation.workspaceScope}`,
    `Tool: ${operation.toolName}`,
    `Target: ${target}`,
    `Operation digest: ${checkpoint.operationDigest}`,
  ];
  if (operation.input?.contentDigest) {
    lines.push(`Content SHA-256: ${operation.input.contentDigest}`);
    lines.push(`Content bytes: ${operation.input.contentBytes}`);
  }
  lines.push(`Approve exactly: APPROVE ${checkpoint.approvalId}`);
  lines.push(`Reject exactly: REJECT ${checkpoint.approvalId}`);
  return lines.join("\n");
}

export function approvalOutcomeText(action, checkpoint, replayed = false) {
  if (action === "reject") {
    return `Rejected ${checkpoint.approvalId}. Tool ${checkpoint.operation.toolName} did not execute.`;
  }
  const suffix = replayed ? " The prior completed result was replayed; no duplicate execution occurred." : "";
  const target = checkpoint.operation.target ?? checkpoint.operation.targetId ?? "bound operation";
  return `Approved and executed ${checkpoint.approvalId}: ${checkpoint.operation.toolName} ${target}.${suffix}`;
}
