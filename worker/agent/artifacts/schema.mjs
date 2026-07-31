import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { artifactError } from "./errors.mjs";
import { artifactProducerDefinition } from "./producer-registry.mjs";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const RUN_ID_PATTERN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const TARGET_ID_PATTERN = /^target-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const ARTIFACT_ID_PATTERN = /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const ARTIFACT_REF_PATTERN = /^artifact-v1\/(artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
export const PURPOSE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_ENVELOPE_BYTES = 32 * 1024;
export const MAX_ARTIFACTS_PER_TARGET = 2048;
export const MAX_CONTENT_BYTES_PER_TARGET = 64 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_RUN = 4096;
export const MAX_CONTENT_BYTES_PER_RUN = 128 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_SESSION = 8192;
export const MAX_CONTENT_BYTES_PER_SESSION = 256 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_OPERATION = 64;
export const MAX_TEMP_BYTES_PER_SESSION = MAX_ARTIFACT_BYTES + MAX_ENVELOPE_BYTES + 2;

const BINDING_KEYS = Object.freeze([
  "actorId",
  "invocationIdentity",
  "kind",
  "practiceRunId",
  "sessionHash",
  "sourceOperationDigest",
  "targetId",
]);

const PUT_KEYS = Object.freeze([
  "binding",
  "canonicalBytes",
  "encoding",
  "mediaType",
  "ordinal",
  "producerId",
  "producerVersion",
  "purpose",
  "transformVersion",
  "truncated",
]);

export const CONTENT_IDENTITY_KEYS = Object.freeze([
  "contentBytes",
  "contentDigest",
  "contentLines",
  "encoding",
  "mediaType",
  "ordinal",
  "producerId",
  "producerVersion",
  "purpose",
  "transformVersion",
  "truncated",
]);

export const ENVELOPE_KEYS = Object.freeze([
  "artifactId",
  "artifactKey",
  "artifactRef",
  "artifactRefDigest",
  "binding",
  "contentBytes",
  "contentDigest",
  "contentLines",
  "createdAt",
  "encoding",
  "envelopeDigest",
  "mediaType",
  "ordinal",
  "producerId",
  "producerVersion",
  "purpose",
  "schemaVersion",
  "transformVersion",
  "truncated",
]);

const RECEIPT_KEYS = Object.freeze([
  "artifactKey",
  "artifactRef",
  "artifactRefDigest",
  "binding",
  "contentBytes",
  "contentDigest",
  "contentLines",
  "encoding",
  "mediaType",
  "ordinal",
  "producerId",
  "producerVersion",
  "purpose",
  "replayed",
  "transformVersion",
  "truncated",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isSafeIntegerIn(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function actorIdIsValid(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= 512;
}

export function validateArtifactBinding(binding, sessionHash) {
  if (
    !hasExactKeys(binding, BINDING_KEYS)
    || binding.kind !== "practice_target"
    || binding.sessionHash !== sessionHash
    || !SHA256_PATTERN.test(binding.sessionHash)
    || !actorIdIsValid(binding.actorId)
    || !RUN_ID_PATTERN.test(binding.practiceRunId)
    || !TARGET_ID_PATTERN.test(binding.targetId)
    || !SHA256_PATTERN.test(binding.invocationIdentity)
    || !SHA256_PATTERN.test(binding.sourceOperationDigest)
  ) {
    throw artifactError("ARTIFACT_BINDING_INVALID");
  }
  return Object.freeze({ ...binding });
}

export function deriveArtifactKey({ binding, purpose, ordinal }) {
  return sha256(canonicalJson({
    schemaId: "tiangong.captured-artifact-key.v1",
    binding,
    purpose,
    ordinal,
  }));
}

export function deriveArtifactRefDigest({ sessionHash, artifactRef }) {
  return sha256(canonicalJson({
    schemaId: "tiangong.captured-artifact-ref.v1",
    sessionHash,
    artifactRef,
  }));
}

export function deriveEnvelopeDigest(envelopeWithoutDigest) {
  return sha256(canonicalJson({
    schemaId: "tiangong.captured-artifact-envelope.v1",
    envelope: envelopeWithoutDigest,
  }));
}

export function decodeReviewText(bytes) {
  for (const byte of bytes) {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      throw artifactError("ARTIFACT_METADATA_INVALID");
    }
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw artifactError("ARTIFACT_METADATA_INVALID");
  }
  return Object.freeze({ text, contentLines: text.split("\n").length });
}

function producerMatches({ producerId, producerVersion, purpose, mediaType, encoding, transformVersion }) {
  const producer = artifactProducerDefinition(producerId);
  return producer
    && producer.producerVersion === producerVersion
    && producer.allowedPurposes.includes(purpose)
    && producer.allowedMediaTypes.includes(mediaType)
    && producer.allowedEncodings.includes(encoding)
    && producer.transformVersions.includes(transformVersion)
    ? producer
    : null;
}

export function validatePutInput(input, sessionHash) {
  const binding = validateArtifactBinding(input?.binding, sessionHash);
  const producer = producerMatches(input ?? {});
  if (!producer || typeof input.purpose !== "string" || !PURPOSE_PATTERN.test(input.purpose)) {
    throw artifactError("ARTIFACT_PRODUCER_NOT_ALLOWED");
  }
  if (
    !hasExactKeys(input, PUT_KEYS)
    || !isSafeIntegerIn(input.ordinal, 0, 63)
    || typeof input.truncated !== "boolean"
  ) {
    throw artifactError("ARTIFACT_METADATA_INVALID");
  }
  if (!Buffer.isBuffer(input.canonicalBytes)) {
    throw artifactError("ARTIFACT_LIMIT_EXCEEDED");
  }
  if (
    input.canonicalBytes.byteLength > MAX_ARTIFACT_BYTES
    || input.canonicalBytes.byteLength > producer.maxContentBytes
  ) {
    throw artifactError("ARTIFACT_LIMIT_EXCEEDED");
  }
  const { contentLines } = decodeReviewText(input.canonicalBytes);
  return Object.freeze({
    binding,
    producer,
    purpose: input.purpose,
    ordinal: input.ordinal,
    mediaType: input.mediaType,
    encoding: input.encoding,
    truncated: input.truncated,
    producerId: input.producerId,
    producerVersion: input.producerVersion,
    transformVersion: input.transformVersion,
    canonicalBytes: Buffer.from(input.canonicalBytes),
    contentDigest: sha256(input.canonicalBytes),
    contentBytes: input.canonicalBytes.byteLength,
    contentLines,
  });
}

function timestampIsValid(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function contentIdentityFromEnvelope(envelope) {
  return Object.freeze(Object.fromEntries(CONTENT_IDENTITY_KEYS.map((key) => [key, envelope[key]])));
}

export function validateExpectedContentIdentity(identity) {
  if (
    !hasExactKeys(identity, CONTENT_IDENTITY_KEYS)
    || typeof identity.purpose !== "string"
    || !PURPOSE_PATTERN.test(identity.purpose)
    || !isSafeIntegerIn(identity.ordinal, 0, 63)
    || !SHA256_PATTERN.test(identity.contentDigest)
    || !isSafeIntegerIn(identity.contentBytes, 0, MAX_ARTIFACT_BYTES)
    || !isSafeIntegerIn(identity.contentLines, 1, Number.MAX_SAFE_INTEGER)
    || typeof identity.truncated !== "boolean"
    || !producerMatches(identity)
    || identity.contentBytes > artifactProducerDefinition(identity.producerId).maxContentBytes
  ) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  return Object.freeze({ ...identity });
}

export function validateEnvelope(envelope, { sessionHash, artifactKey, wireBytes, contentStatSize }) {
  if (!hasExactKeys(envelope, ENVELOPE_KEYS)) throw artifactError("ARTIFACT_STORE_CORRUPTED");
  const binding = validateArtifactBindingForStore(envelope.binding, sessionHash);
  const withoutDigest = { ...envelope };
  delete withoutDigest.envelopeDigest;
  const canonicalWire = Buffer.from(canonicalJson(envelope), "utf8");
  const artifactRefMatch = typeof envelope.artifactRef === "string"
    ? ARTIFACT_REF_PATTERN.exec(envelope.artifactRef)
    : null;
  if (
    envelope.schemaVersion !== 1
    || !ARTIFACT_ID_PATTERN.test(envelope.artifactId)
    || !artifactRefMatch
    || artifactRefMatch[1] !== envelope.artifactId
    || !SHA256_PATTERN.test(envelope.artifactRefDigest)
    || !SHA256_PATTERN.test(envelope.artifactKey)
    || envelope.artifactKey !== artifactKey
    || deriveArtifactKey(envelope) !== artifactKey
    || deriveArtifactRefDigest({ sessionHash, artifactRef: envelope.artifactRef }) !== envelope.artifactRefDigest
    || !SHA256_PATTERN.test(envelope.contentDigest)
    || !isSafeIntegerIn(envelope.contentBytes, 0, MAX_ARTIFACT_BYTES)
    || envelope.contentBytes !== contentStatSize
    || !isSafeIntegerIn(envelope.contentLines, 1, Number.MAX_SAFE_INTEGER)
    || typeof envelope.truncated !== "boolean"
    || !producerMatches(envelope)
    || envelope.contentBytes > artifactProducerDefinition(envelope.producerId).maxContentBytes
    || !timestampIsValid(envelope.createdAt)
    || !SHA256_PATTERN.test(envelope.envelopeDigest)
    || deriveEnvelopeDigest(withoutDigest) !== envelope.envelopeDigest
    || !Buffer.isBuffer(wireBytes)
    || wireBytes.byteLength > MAX_ENVELOPE_BYTES
    || !wireBytes.equals(canonicalWire)
  ) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  return Object.freeze({ ...envelope, binding });
}

function validateArtifactBindingForStore(binding, sessionHash) {
  try {
    return validateArtifactBinding(binding, sessionHash);
  } catch {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
}

export function receiptFromEnvelope(envelope, replayed) {
  const receipt = {
    artifactRef: envelope.artifactRef,
    artifactRefDigest: envelope.artifactRefDigest,
    artifactKey: envelope.artifactKey,
    ordinal: envelope.ordinal,
    contentDigest: envelope.contentDigest,
    contentBytes: envelope.contentBytes,
    contentLines: envelope.contentLines,
    mediaType: envelope.mediaType,
    encoding: envelope.encoding,
    truncated: envelope.truncated,
    purpose: envelope.purpose,
    producerId: envelope.producerId,
    producerVersion: envelope.producerVersion,
    transformVersion: envelope.transformVersion,
    binding: Object.freeze({ ...envelope.binding }),
    replayed,
  };
  if (!hasExactKeys(receipt, RECEIPT_KEYS)) throw new Error("Artifact receipt projection is invalid");
  return Object.freeze(receipt);
}

export function evidenceMetadataFromReceipt(receipt) {
  return Object.freeze({
    artifactKey: receipt.artifactKey,
    artifactRefDigest: receipt.artifactRefDigest,
    ordinal: receipt.ordinal,
    contentDigest: receipt.contentDigest,
    contentBytes: receipt.contentBytes,
    contentLines: receipt.contentLines,
    mediaType: receipt.mediaType,
    encoding: receipt.encoding,
    truncated: receipt.truncated,
    purpose: receipt.purpose,
    producerId: receipt.producerId,
    producerVersion: receipt.producerVersion,
    transformVersion: receipt.transformVersion,
  });
}

export function contentIdentityEquals(left, right) {
  return CONTENT_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}
