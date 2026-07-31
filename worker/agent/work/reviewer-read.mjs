import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { Type } from "typebox";

import { sha256 } from "../canonical-json.mjs";
import { practiceRunFail } from "../practices/errors.mjs";
import { resolveWorkspacePath } from "../tools/operations.mjs";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_LINES = 100_000;
const MAX_RETURNED_BYTES = 50 * 1024;
const MAX_READ_LINES = 2_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function mapPathError(error) {
  if (error?.code === "ENOENT") practiceRunFail("PATH_NOT_REGULAR_FILE", "Read target is not a regular file");
  if (error?.code === "ELOOP" || /symbolic link/iu.test(error?.message ?? "")) {
    practiceRunFail("SYMLINK_DENIED", "Symbolic links are not allowed for Reviewer reads");
  }
  if (/outside the authorized workspace/iu.test(error?.message ?? "")) {
    practiceRunFail("PATH_OUTSIDE_WORKSPACE", "Read target is outside the authorized workspace");
  }
  if (/credential-bearing|runtime state directory/iu.test(error?.message ?? "")) {
    practiceRunFail("SENSITIVE_PATH_DENIED", "Sensitive paths are not accessible to Reviewer reads");
  }
  if (error?.name === "PracticeRunError") throw error;
  practiceRunFail("READ_FAILED", "Reviewer read could not validate or capture the requested file");
}

async function openedFilePath(handle) {
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return realpath(`/dev/fd/${handle.fd}`);
  }
}

function range(params, lineCount, lines) {
  const offset = params.offset ?? 1;
  const requestedLimit = params.limit ?? MAX_READ_LINES;
  if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1 || requestedLimit > MAX_READ_LINES || offset > lineCount) {
    practiceRunFail("READ_RANGE_INVALID", "Read offset or limit is outside the supported line range");
  }
  const maximumEnd = Math.min(lineCount, offset + requestedLimit - 1);
  let end = offset - 1;
  let bytes = 0;
  for (let line = offset; line <= maximumEnd; line += 1) {
    const addition = Buffer.byteLength(lines[line - 1]) + (line === offset ? 0 : 1);
    if (bytes + addition > MAX_RETURNED_BYTES) break;
    bytes += addition;
    end = line;
  }
  if (end < offset) practiceRunFail("FILE_LIMIT_EXCEEDED", "A single text line exceeds the read output limit");
  return { offset, end, bytes };
}

export const REVIEWER_READ_DEFINITION = Object.freeze({
  name: "read",
  label: "Tiangong scoped review read",
  description: "Read only an explicit UTF-8 text file in the active review scope, by bounded line range.",
  parameters: Type.Object({
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES })),
  }, { additionalProperties: false }),
});

export async function prepareReviewerRead({ workspaceDir, service, params, invocation }) {
  const actorId = invocation.actor?.id;
  const run = await service.activeForActor(actorId);
  let target;
  try {
    target = await resolveWorkspacePath(workspaceDir, params.path);
  } catch (error) {
    mapPathError(error);
  }
  if (!run.scope.files.includes(target.relativePath)) {
    practiceRunFail("PATH_NOT_IN_PRACTICE_SCOPE", "Read target is not in the final PracticeRun scope");
  }
  const operation = {
    policyVersion: "review-read-v1",
    category: "read-only",
    toolName: "read",
    workspaceScope: target.workspaceScope,
    roleId: run.roleId,
    profileDigest: run.profileDigest,
    practiceId: run.practiceId,
    practiceVersion: run.practiceVersion,
    state: { runId: run.runId, expectedRunRevision: run.revision },
    target: target.relativePath,
    input: { offset: params.offset ?? 1, limit: params.limit ?? MAX_READ_LINES },
  };
  return Object.freeze({ operation: Object.freeze(operation), target, run });
}

export async function executeReviewerRead(prepared) {
  let handle;
  try {
    handle = await open(prepared.target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    const openedPath = await openedFilePath(handle);
    if (openedPath !== prepared.target.absolutePath) {
      practiceRunFail("PATH_OUTSIDE_WORKSPACE", "Opened read target changed after path authorization");
    }
    if (!before.isFile()) practiceRunFail("PATH_NOT_REGULAR_FILE", "Read target is not a regular file");
    if (before.size > MAX_FILE_BYTES) practiceRunFail("FILE_LIMIT_EXCEEDED", "Read target exceeds the file size limit");
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        buffer.byteLength !== before.size) {
      practiceRunFail("FILE_CHANGED_DURING_READ", "Read target changed while it was being captured");
    }
    if (buffer.some((byte) => (byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127)) {
      practiceRunFail("BINARY_FILE_UNSUPPORTED", "Binary files are not supported by Reviewer v1");
    }
    let text;
    try {
      text = UTF8.decode(buffer);
    } catch {
      practiceRunFail("INVALID_UTF8", "Reviewer v1 requires valid UTF-8 text");
    }
    const lines = text.split("\n");
    if (lines.length > MAX_FILE_LINES) practiceRunFail("FILE_LIMIT_EXCEEDED", "Read target exceeds the line limit");
    const selected = range(prepared.operation.input, lines.length, lines);
    const returnedText = lines.slice(selected.offset - 1, selected.end).join("\n");
    const metadata = {
      fileDigest: sha256(buffer),
      fullFileBytes: buffer.byteLength,
      fullFileLines: lines.length,
      returnedLineStart: selected.offset,
      returnedLineEnd: selected.end,
      returnedBytes: Buffer.byteLength(returnedText),
      returnedLines: selected.end - selected.offset + 1,
      truncated: selected.end < lines.length,
    };
    const displayText = metadata.truncated
      ? `${returnedText}\n\n[Showing lines ${metadata.returnedLineStart}-${metadata.returnedLineEnd} of ${metadata.fullFileLines}. Continue with offset=${metadata.returnedLineEnd + 1}.]`
      : returnedText;
    return {
      content: [{ type: "text", text: displayText }],
      details: { ...metadata, path: prepared.target.relativePath, runId: prepared.run.runId },
    };
  } catch (error) {
    mapPathError(error);
  } finally {
    await handle?.close();
  }
}

export function reviewerReadEvidenceMetadata(result) {
  const details = result?.details;
  return {
    resultMetadata: {
      fileDigest: details.fileDigest,
      fullFileBytes: details.fullFileBytes,
      fullFileLines: details.fullFileLines,
      returnedLineStart: details.returnedLineStart,
      returnedLineEnd: details.returnedLineEnd,
      returnedBytes: details.returnedBytes,
      returnedLines: details.returnedLines,
      truncated: details.truncated,
    },
  };
}
