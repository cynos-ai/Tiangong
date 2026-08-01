import { canonicalJson } from "../canonical-json.mjs";

const DIGEST = /^[a-f0-9]{64}$/u;
const TARGET_ID = /^target-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const REVIEW_TARGET_CONSUME = Object.freeze({
  producerId: "review-target-consume",
  producerVersion: 1,
  allowedPurposes: Object.freeze(["review_target_chunk"]),
  allowedMediaTypes: Object.freeze(["text/plain;charset=utf-8"]),
  allowedEncodings: Object.freeze(["utf-8"]),
  maxContentBytes: 50 * 1024,
  textPolicyId: "review-text-lines-v1",
  transformVersions: Object.freeze([1]),
});

const REVIEW_DIRECTORY_CAPTURE = Object.freeze({
  producerId: "review-directory-capture",
  producerVersion: 1,
  allowedPurposes: Object.freeze(["directory_manifest"]),
  allowedMediaTypes: Object.freeze(["application/vnd.tiangong.directory-manifest+json;version=1"]),
  allowedEncodings: Object.freeze(["utf-8"]),
  maxContentBytes: 4 * 1024 * 1024,
  textPolicyId: "canonical-json-v1",
  transformVersions: Object.freeze([1]),
});

const REVIEW_GIT_COMMIT_CAPTURE = Object.freeze({
  producerId: "review-git-commit-capture",
  producerVersion: 1,
  allowedPurposes: Object.freeze(["git_tree_manifest"]),
  allowedMediaTypes: Object.freeze(["application/vnd.tiangong.git-tree-manifest+json;version=1"]),
  allowedEncodings: Object.freeze(["utf-8"]),
  maxContentBytes: 4 * 1024 * 1024,
  textPolicyId: "canonical-json-v1",
  transformVersions: Object.freeze([1]),
});

const REVIEW_GIT_DIFF_CAPTURE = Object.freeze({
  producerId: "review-git-diff-capture",
  producerVersion: 1,
  allowedPurposes: Object.freeze(["git_diff"]),
  allowedMediaTypes: Object.freeze(["text/x-diff;charset=utf-8"]),
  allowedEncodings: Object.freeze(["utf-8"]),
  maxContentBytes: 4 * 1024 * 1024,
  textPolicyId: "review-git-diff-v1",
  transformVersions: Object.freeze([1]),
});

const REVIEW_GIT_INSPECT = Object.freeze({
  producerId: "review-git-inspect",
  producerVersion: 1,
  allowedPurposes: Object.freeze(["git_commit_list"]),
  allowedMediaTypes: Object.freeze(["application/vnd.tiangong.git-commit-list+json;version=1"]),
  allowedEncodings: Object.freeze(["utf-8"]),
  maxContentBytes: 64 * 1024,
  textPolicyId: "canonical-json-v1",
  transformVersions: Object.freeze([1]),
});

const REVIEW_DIRECTORY_INSPECT = Object.freeze({
  producerId: "review-directory-inspect",
  producerVersion: 1,
  allowedPurposes: Object.freeze(["directory_list", "directory_search"]),
  allowedMediaTypes: Object.freeze([
    "application/vnd.tiangong.directory-list+json;version=1",
    "application/vnd.tiangong.directory-search+json;version=1",
  ]),
  allowedEncodings: Object.freeze(["utf-8"]),
  maxContentBytes: 64 * 1024,
  textPolicyId: "canonical-json-v1",
  transformVersions: Object.freeze([1]),
});

const PRODUCERS = new Map([
  [REVIEW_TARGET_CONSUME.producerId, REVIEW_TARGET_CONSUME],
  [REVIEW_DIRECTORY_CAPTURE.producerId, REVIEW_DIRECTORY_CAPTURE],
  [REVIEW_GIT_COMMIT_CAPTURE.producerId, REVIEW_GIT_COMMIT_CAPTURE],
  [REVIEW_GIT_DIFF_CAPTURE.producerId, REVIEW_GIT_DIFF_CAPTURE],
  [REVIEW_DIRECTORY_INSPECT.producerId, REVIEW_DIRECTORY_INSPECT],
  [REVIEW_GIT_INSPECT.producerId, REVIEW_GIT_INSPECT],
]);

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRootPath(value) {
  return (value === "." || validRelativePath(value)) && Buffer.byteLength(value, "utf8") <= 1024;
}

function validPrefix(value) {
  return (value === "." || validRelativePath(value)) && Buffer.byteLength(value, "utf8") <= 1024;
}

function prefixMatches(path, prefix) {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

function validRelativePath(value) {
  return typeof value === "string" && value !== "" && value !== "." && !value.startsWith("/")
    && !value.endsWith("/") && !value.includes("\0")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validateManifest(value) {
  if (!exact(value, ["schemaVersion", "kind", "rootPath", "selectionDigest", "members"])
      || value.schemaVersion !== 1 || value.kind !== "directory-manifest"
      || !validRootPath(value.rootPath) || !DIGEST.test(value.selectionDigest)
      || !Array.isArray(value.members) || value.members.length === 0 || value.members.length > 960) return false;
  let previous = null;
  for (const member of value.members) {
    if (!exact(member, [
      "path", "contentDigest", "contentBytes", "contentLines", "encoding", "requiredConsumeSegments",
    ]) || !validRelativePath(member.path) || Buffer.byteLength(member.path, "utf8") > 1024
      || !DIGEST.test(member.contentDigest) || !safeCount(member.contentBytes) || member.contentBytes > 2 * 1024 * 1024
      || !Number.isSafeInteger(member.contentLines) || member.contentLines < 1
      || member.contentLines > member.contentBytes + 1
      || member.encoding !== "utf-8" || !Number.isSafeInteger(member.requiredConsumeSegments)
      || member.requiredConsumeSegments < 1 || member.requiredConsumeSegments > 128) return false;
    const path = Buffer.from(member.path, "utf8");
    if (previous && Buffer.compare(previous, path) >= 0) return false;
    previous = path;
  }
  const totalBytes = value.members.reduce((sum, member) => sum + member.contentBytes, 0);
  const totalSegments = value.members.reduce((sum, member) => sum + member.requiredConsumeSegments, 0);
  return totalBytes <= 16 * 1024 * 1024 && totalSegments <= 960;
}

function validOid(value, objectFormat) {
  return typeof value === "string" && (objectFormat === "sha1" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(value);
}

function validateGitManifest(value) {
  if (!exact(value, [
    "schemaVersion", "kind", "repositoryPath", "objectFormat", "commitOid", "treeOid", "selectionDigest", "members",
  ]) || value.schemaVersion !== 1 || value.kind !== "git-tree-manifest" || !validRootPath(value.repositoryPath)
      || !["sha1", "sha256"].includes(value.objectFormat) || !validOid(value.commitOid, value.objectFormat)
      || !validOid(value.treeOid, value.objectFormat) || !DIGEST.test(value.selectionDigest)
      || !Array.isArray(value.members) || value.members.length === 0 || value.members.length > 256) return false;
  let previous = null;
  let bytes = 0;
  let segments = 0;
  for (const member of value.members) {
    if (!exact(member, [
      "path", "mode", "blobOid", "contentDigest", "contentBytes", "contentLines", "encoding", "requiredConsumeSegments",
    ]) || !validRelativePath(member.path) || Buffer.byteLength(member.path, "utf8") > 1024
      || !["100644", "100755"].includes(member.mode) || !validOid(member.blobOid, value.objectFormat)
      || !DIGEST.test(member.contentDigest) || !safeCount(member.contentBytes) || member.contentBytes > 2 * 1024 * 1024
      || !Number.isSafeInteger(member.contentLines) || member.contentLines < 1
      || member.encoding !== "utf-8" || !Number.isSafeInteger(member.requiredConsumeSegments)
      || member.requiredConsumeSegments < 1 || member.requiredConsumeSegments > 128) return false;
    const current = Buffer.from(member.path, "utf8");
    if (previous && Buffer.compare(previous, current) >= 0) return false;
    previous = current;
    bytes += member.contentBytes;
    segments += member.requiredConsumeSegments;
  }
  return bytes <= 16 * 1024 * 1024 && segments <= 960;
}

function validateGitList(value) {
  if (!exact(value, [
    "schemaVersion", "kind", "targetId", "prefix", "offset", "returnedCount", "totalMatchingMembers", "truncated", "members",
  ]) || value.schemaVersion !== 1 || value.kind !== "git-commit-list" || !TARGET_ID.test(value.targetId)
      || !validPrefix(value.prefix) || !safeCount(value.offset) || !safeCount(value.returnedCount)
      || value.returnedCount < 1 || !safeCount(value.totalMatchingMembers) || value.totalMatchingMembers < 1
      || value.totalMatchingMembers > 256 || value.offset >= value.totalMatchingMembers || value.returnedCount > 200
      || value.offset + value.returnedCount > value.totalMatchingMembers
      || value.truncated !== (value.offset + value.returnedCount < value.totalMatchingMembers)
      || !Array.isArray(value.members) || value.members.length !== value.returnedCount) return false;
  let previous = null;
  for (const member of value.members) {
    if (!exact(member, ["path", "mode", "contentBytes", "contentLines"])
        || !validRelativePath(member.path) || !prefixMatches(member.path, value.prefix)
        || !["100644", "100755"].includes(member.mode) || !safeCount(member.contentBytes)
        || member.contentBytes > 2 * 1024 * 1024 || !Number.isSafeInteger(member.contentLines) || member.contentLines < 1) return false;
    const current = Buffer.from(member.path, "utf8");
    if (previous && Buffer.compare(previous, current) >= 0) return false;
    previous = current;
  }
  return true;
}

function validateList(value) {
  if (!exact(value, [
    "schemaVersion", "kind", "targetId", "prefix", "offset", "returnedCount",
    "totalMatchingMembers", "truncated", "members",
  ]) || value.schemaVersion !== 1 || value.kind !== "directory-list" || !TARGET_ID.test(value.targetId)
      || !validPrefix(value.prefix) || !safeCount(value.offset) || !safeCount(value.returnedCount)
      || value.returnedCount < 1 || !safeCount(value.totalMatchingMembers)
      || value.totalMatchingMembers < 1 || value.totalMatchingMembers > 960
      || value.offset >= value.totalMatchingMembers || value.returnedCount > 200
      || value.offset + value.returnedCount > value.totalMatchingMembers
      || value.truncated !== (value.offset + value.returnedCount < value.totalMatchingMembers)
      || !Array.isArray(value.members) || value.members.length !== value.returnedCount) return false;
  let previous = null;
  for (const member of value.members) {
    if (!exact(member, ["path", "contentBytes", "contentLines"])
        || !validRelativePath(member.path) || Buffer.byteLength(member.path, "utf8") > 1024
        || !prefixMatches(member.path, value.prefix) || !safeCount(member.contentBytes)
        || member.contentBytes > 2 * 1024 * 1024 || !Number.isSafeInteger(member.contentLines)
        || member.contentLines < 1 || member.contentLines > member.contentBytes + 1) return false;
    const current = Buffer.from(member.path, "utf8");
    if (previous && Buffer.compare(previous, current) >= 0) return false;
    previous = current;
  }
  return true;
}

function validateSearch(value) {
  if (!exact(value, [
    "schemaVersion", "kind", "targetId", "prefix", "matchMode", "returnedCount",
    "totalMatchCount", "truncated", "matches",
  ]) || value.schemaVersion !== 1 || value.kind !== "directory-search" || !TARGET_ID.test(value.targetId)
      || !validPrefix(value.prefix) || value.matchMode !== "literal-case-sensitive-v1"
      || !safeCount(value.returnedCount) || value.returnedCount > 200 || !safeCount(value.totalMatchCount)
      || value.totalMatchCount < value.returnedCount || value.truncated !== (value.totalMatchCount > value.returnedCount)
      || !Array.isArray(value.matches) || value.matches.length !== value.returnedCount) return false;
  let previousPath = null;
  let previousLine = 0;
  for (const match of value.matches) {
    if (!exact(match, ["memberPath", "line"]) || !validRelativePath(match.memberPath)
        || Buffer.byteLength(match.memberPath, "utf8") > 1024
        || !prefixMatches(match.memberPath, value.prefix) || !Number.isSafeInteger(match.line) || match.line < 1) return false;
    if (previousPath !== null) {
      const compared = Buffer.compare(Buffer.from(previousPath, "utf8"), Buffer.from(match.memberPath, "utf8"));
      if (compared > 0 || (compared === 0 && match.line <= previousLine)) return false;
    }
    previousPath = match.memberPath;
    previousLine = match.line;
  }
  return true;
}

function validReviewText(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { return null; }
  for (const character of text) {
    const code = character.codePointAt(0);
    if ((code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) || code === 0x7f) return null;
  }
  return text;
}

function validateGitDiff(bytes) {
  const text = validReviewText(bytes);
  if (text === null || text.length === 0
      || /^(?:GIT binary patch|Binary files |Submodule |diff --cc|diff --combined)/mu.test(text)) return false;
  const paths = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/([A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*) b\/\1$/u.exec(line);
    if (!match) return false;
    if (match[1].split("/").some((segment) => segment.startsWith("-") || segment === "." || segment === "..")) return false;
    paths.push(match[1]);
  }
  if (paths.length === 0 || new Set(paths).size !== paths.length) return false;
  for (let index = 1; index < paths.length; index += 1) {
    if (Buffer.compare(Buffer.from(paths[index - 1], "utf8"), Buffer.from(paths[index], "utf8")) >= 0) return false;
  }
  return true;
}

export function validateArtifactProducerBytes(producer, bytes, metadata = {}) {
  if (producer.textPolicyId === "review-text-lines-v1") return validReviewText(bytes) !== null;
  if (producer.textPolicyId === "review-git-diff-v1") {
    return metadata.purpose === "git_diff" && metadata.mediaType === "text/x-diff;charset=utf-8"
      && metadata.truncated === false && validateGitDiff(bytes);
  }
  if (producer.textPolicyId !== "canonical-json-v1") return false;
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Buffer.from(canonicalJson(parsed), "utf8").equals(bytes)) return false;
  if (producer.producerId === "review-directory-capture") {
    return metadata.purpose === "directory_manifest"
      && metadata.mediaType === "application/vnd.tiangong.directory-manifest+json;version=1"
      && validateManifest(parsed);
  }
  if (producer.producerId === "review-git-commit-capture") {
    return metadata.purpose === "git_tree_manifest"
      && metadata.mediaType === "application/vnd.tiangong.git-tree-manifest+json;version=1"
      && metadata.truncated === false && validateGitManifest(parsed);
  }
  if (producer.producerId === "review-git-inspect") {
    return metadata.purpose === "git_commit_list"
      && metadata.mediaType === "application/vnd.tiangong.git-commit-list+json;version=1"
      && metadata.truncated === false && validateGitList(parsed);
  }
  if (producer.producerId === "review-directory-inspect") {
    if (parsed.kind === "directory-list") {
      return metadata.purpose === "directory_list"
        && metadata.mediaType === "application/vnd.tiangong.directory-list+json;version=1"
        && validateList(parsed);
    }
    if (parsed.kind === "directory-search") {
      return metadata.purpose === "directory_search"
        && metadata.mediaType === "application/vnd.tiangong.directory-search+json;version=1"
        && validateSearch(parsed);
    }
    return false;
  }
  return false;
}

export function artifactProducerDefinition(producerId) {
  return PRODUCERS.get(producerId) ?? null;
}

export function artifactProducerIds() {
  return Object.freeze([...PRODUCERS.keys()]);
}
