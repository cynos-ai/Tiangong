import { Type } from "typebox";

import { evidenceMetadataFromReceipt } from "../artifacts/schema.mjs";
import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { practiceRunFail } from "../practices/errors.mjs";
import { practiceInvocationIdentity } from "../practices/practice-run-store.mjs";
import {
  TARGET_ID_PATTERN,
  findTarget,
  normalizeRelativePath,
} from "../practices/review-targets.mjs";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_QUERY_BYTES = 256;
const MAX_RESULTS = 200;
const EFFECTS = Object.freeze({
  localRead: true,
  workspaceMutation: false,
  networkEgress: false,
  modelInference: false,
  costBearing: false,
});

export const REVIEWER_DIRECTORY_DEFINITION = Object.freeze({
  name: "inspect_directory",
  label: "Inspect review directory snapshot",
  description: "List immutable manifest members or search snapshot-matching member text with a bounded literal query.",
  parameters: Type.Union([
    Type.Object({
      targetId: Type.String({ minLength: 43, maxLength: 43 }),
      action: Type.Literal("list"),
      prefix: Type.String({ minLength: 1, maxLength: 1024 }),
      offset: Type.Integer({ minimum: 0 }),
      limit: Type.Integer({ minimum: 1, maximum: MAX_RESULTS }),
    }, { additionalProperties: false }),
    Type.Object({
      targetId: Type.String({ minLength: 43, maxLength: 43 }),
      action: Type.Literal("search"),
      prefix: Type.String({ minLength: 1, maxLength: 1024 }),
      query: Type.String({ minLength: 1, maxLength: MAX_QUERY_BYTES }),
      maxResults: Type.Integer({ minimum: 1, maximum: MAX_RESULTS }),
    }, { additionalProperties: false }),
  ]),
});

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function prefixMatches(path, prefix) {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

function prefixDigest(prefix) {
  return sha256(canonicalJson({ schemaId: "tiangong.directory-prefix.v1", prefix }));
}

function queryDigest(query) {
  return sha256(canonicalJson({ schemaId: "tiangong.directory-query.v1", query }));
}

function inspectionSelectorDigest(input) {
  return sha256(canonicalJson({ schemaId: "tiangong.directory-inspection-selector.v1", ...input }));
}

function validateQuery(value) {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > MAX_QUERY_BYTES
      || [...value].some((character) => {
        const code = character.codePointAt(0);
        return code === 0x7f || code < 0x20;
      })) {
    practiceRunFail("DIRECTORY_QUERY_INVALID", "Directory search query is invalid");
  }
  return value;
}

function validateParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)
      || !TARGET_ID_PATTERN.test(params.targetId) || !["list", "search"].includes(params.action)) {
    practiceRunFail("DIRECTORY_INSPECTION_INVALID", "Directory inspection input is invalid");
  }
  if (params.action === "list") {
    if (!exact(params, ["action", "limit", "offset", "prefix", "targetId"])) {
      practiceRunFail("DIRECTORY_INSPECTION_INVALID", "Directory list input has missing or unknown fields");
    }
    if (!Number.isSafeInteger(params.offset) || params.offset < 0 || !Number.isSafeInteger(params.limit)
        || params.limit < 1 || params.limit > MAX_RESULTS) {
      practiceRunFail("TARGET_RANGE_INVALID", "Directory list range is invalid");
    }
  } else {
    if (!exact(params, ["action", "maxResults", "prefix", "query", "targetId"])) {
      practiceRunFail("DIRECTORY_INSPECTION_INVALID", "Directory search input has missing or unknown fields");
    }
    if (!Number.isSafeInteger(params.maxResults) || params.maxResults < 1 || params.maxResults > MAX_RESULTS) {
      practiceRunFail("TARGET_RANGE_INVALID", "Directory search result limit is invalid");
    }
    validateQuery(params.query);
  }
}

function mapArtifactError(error) {
  if (error?.name !== "CapturedArtifactError") throw error;
  if (["ARTIFACT_LIMIT_EXCEEDED", "ARTIFACT_PRODUCER_NOT_ALLOWED", "ARTIFACT_METADATA_INVALID"].includes(error.code)) {
    practiceRunFail("TARGET_LIMIT_EXCEEDED", "Directory inspection output violates its producer limit");
  }
  if (error.code === "ARTIFACT_QUOTA_EXCEEDED") {
    practiceRunFail("CAPTURE_LIMIT_EXCEEDED", "Directory inspection artifacts exceed aggregate quota");
  }
  practiceRunFail("TARGET_UNAVAILABLE", "Directory inspection artifact storage is unavailable");
}

export async function prepareDirectoryInspection({ service, params, invocation }) {
  validateParams(params);
  let normalizedPrefix;
  try {
    normalizedPrefix = normalizeRelativePath(params.prefix, { allowRoot: true, sensitive: false });
  } catch (error) {
    if (error?.code === "TARGET_LIMIT_EXCEEDED") {
      practiceRunFail("TARGET_SELECTOR_INVALID", "Directory prefix exceeds its selector limit");
    }
    throw error;
  }
  const actorId = invocation.actor?.id;
  const run = await service.activeForActor(actorId);
  await service.targetCapture.initialize();
  const qDigest = params.action === "search" ? queryDigest(params.query) : null;
  const selector = {
    action: params.action,
    prefix: normalizedPrefix,
    offset: params.action === "list" ? params.offset : null,
    limit: params.action === "list" ? params.limit : null,
    queryDigest: qDigest,
    maxResults: params.action === "search" ? params.maxResults : null,
  };
  const selectorDigest = inspectionSelectorDigest(selector);
  const operation = Object.freeze({
    policyVersion: "review-directory-inspect-v1",
    category: "read-only",
    toolName: "inspect_directory",
    effects: EFFECTS,
    workspaceScope: service.targetCapture.workspaceScope,
    roleId: run.roleId,
    profileDigest: run.profileDigest,
    practiceId: run.practiceId,
    practiceVersion: 2,
    state: { runId: run.runId, expectedRunRevision: run.revision, targetId: params.targetId },
    input: {
      action: params.action,
      selectorDigest,
      prefixDigest: prefixDigest(normalizedPrefix),
      prefixBytes: Buffer.byteLength(normalizedPrefix, "utf8"),
      offset: selector.offset,
      limit: selector.limit,
      queryDigest: qDigest,
      queryBytes: params.action === "search" ? Buffer.byteLength(params.query, "utf8") : null,
      maxResults: selector.maxResults,
      inspectionPolicyVersion: "review-directory-inspection-v1",
    },
  });
  return Object.freeze({
    operation,
    actorId,
    run,
    normalizedPrefix,
    query: params.action === "search" ? params.query : null,
    selectorDigest,
    invocationIdentity: practiceInvocationIdentity({
      sessionId: invocation.sessionId,
      turnId: invocation.turnId,
      toolCallId: invocation.toolCallId,
    }),
  });
}

export async function executeDirectoryInspection(prepared, { service, actionDigest }) {
  const current = await service.activeForActor(prepared.actorId);
  if (current.runId !== prepared.run.runId || current.revision !== prepared.run.revision) {
    practiceRunFail("STALE_RUN_REVISION", "PracticeRun revision changed before directory inspection");
  }
  const target = findTarget(current, prepared.operation.state.targetId);
  if (target.kind !== "directory_snapshot") {
    practiceRunFail("TARGET_KIND_MISMATCH", "inspect_directory requires a directory target");
  }
  const manifest = await service.targetCapture.readDirectoryManifest(target);
  const matching = manifest.members.filter((member) => prefixMatches(member.path, prepared.normalizedPrefix));
  if (matching.length === 0) practiceRunFail("DIRECTORY_PREFIX_EMPTY", "Directory prefix matches no manifest member");

  let output;
  let resultCount;
  let truncated;
  let purpose;
  let mediaType;
  if (prepared.operation.input.action === "list") {
    const { offset, limit } = prepared.operation.input;
    if (offset >= matching.length) practiceRunFail("TARGET_RANGE_INVALID", "Directory list offset is outside the matching range");
    const members = matching.slice(offset, offset + limit).map((member) => ({
      path: member.path,
      contentBytes: member.contentBytes,
      contentLines: member.contentLines,
    }));
    resultCount = members.length;
    truncated = offset + resultCount < matching.length;
    output = {
      schemaVersion: 1,
      kind: "directory-list",
      targetId: target.targetId,
      prefix: prepared.normalizedPrefix,
      offset,
      returnedCount: resultCount,
      totalMatchingMembers: matching.length,
      truncated,
      members,
    };
    purpose = "directory_list";
    mediaType = "application/vnd.tiangong.directory-list+json;version=1";
  } else {
    const matches = [];
    let totalMatchCount = 0;
    for (const member of matching) {
      const resource = await service.targetCapture.captureResource(target, member.path);
      for (let index = 0; index < resource.lines.length; index += 1) {
        if (resource.lines[index].includes(prepared.query)) {
          totalMatchCount += 1;
          if (matches.length < prepared.operation.input.maxResults) {
            matches.push({ memberPath: member.path, line: index + 1 });
          }
        }
      }
    }
    resultCount = matches.length;
    truncated = totalMatchCount > resultCount;
    output = {
      schemaVersion: 1,
      kind: "directory-search",
      targetId: target.targetId,
      prefix: prepared.normalizedPrefix,
      matchMode: "literal-case-sensitive-v1",
      returnedCount: resultCount,
      totalMatchCount,
      truncated,
      matches,
    };
    purpose = "directory_search";
    mediaType = "application/vnd.tiangong.directory-search+json;version=1";
  }

  const text = canonicalJson(output);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_OUTPUT_BYTES) {
    practiceRunFail("TARGET_LIMIT_EXCEEDED", "Directory inspection output exceeds its fixed byte limit");
  }
  let receipt;
  try {
    receipt = await service.artifactStore.put({
      binding: {
        kind: "practice_target",
        sessionHash: service.artifactStore.sessionHash,
        actorId: prepared.actorId,
        practiceRunId: current.runId,
        targetId: target.targetId,
        invocationIdentity: prepared.invocationIdentity,
        sourceOperationDigest: actionDigest,
      },
      purpose,
      ordinal: 0,
      mediaType,
      encoding: "utf-8",
      truncated,
      producerId: "review-directory-inspect",
      producerVersion: 1,
      transformVersion: 1,
      canonicalBytes: bytes,
    });
  } catch (error) {
    mapArtifactError(error);
  }
  const reviewDirectoryInspection = Object.freeze({
    targetId: target.targetId,
    snapshotIdentity: target.snapshot.identity,
    action: prepared.operation.input.action,
    selectorDigest: prepared.selectorDigest,
    resultCount,
    truncated,
    artifact: evidenceMetadataFromReceipt(receipt),
  });
  return {
    content: [{ type: "text", text }],
    details: { targetId: target.targetId, action: prepared.operation.input.action, resultCount, truncated },
    reviewDirectoryInspection,
  };
}

export function directoryInspectionEvidenceMetadata(result) {
  return { metadata: { reviewDirectoryInspection: result.reviewDirectoryInspection } };
}
