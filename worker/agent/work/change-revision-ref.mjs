// ChangeRevisionRef: a lightweight immutable reference to an artifact sealed
// by a Task (architecture §8). It guarantees the Assessor verifies and the
// Operator deploys the same revision the Implementor sealed, without a
// candidate service, ledger, or separate state machine.

import { canonicalJson, sha256 } from "../canonical-json.mjs";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

function demandString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

export function createChangeRevisionRef(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("change revision ref input must be an object");
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    throw new TypeError("revision must be a non-negative integer");
  }
  const base = Object.freeze({
    kind: "tiangong.change-revision-ref",
    schemaVersion: 1,
    producerTaskId: demandString(input.producerTaskId, "producerTaskId"),
    artifactPath: demandString(input.artifactPath, "artifactPath"),
    artifactDigest: demandString(input.artifactDigest, "artifactDigest"),
    revision: input.revision,
  });
  if (!ID_PATTERN.test(base.producerTaskId)) throw new Error("producerTaskId has an invalid format");
  if (!DIGEST_PATTERN.test(base.artifactDigest)) throw new Error("artifactDigest must be a 64-hex digest");
  if (base.artifactPath.length > 1024 || !PATH_PATTERN.test(base.artifactPath) ||
      base.artifactPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("artifactPath has an invalid format");
  }
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}

export function isChangeRevisionRef(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const recreated = createChangeRevisionRef({
      producerTaskId: value.producerTaskId,
      artifactPath: value.artifactPath,
      artifactDigest: value.artifactDigest,
      revision: value.revision,
    });
    return canonicalJson(recreated) === canonicalJson(value);
  } catch {
    return false;
  }
}
