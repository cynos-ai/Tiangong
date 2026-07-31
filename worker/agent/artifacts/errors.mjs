const MESSAGES = Object.freeze({
  ARTIFACT_BINDING_INVALID: "Artifact binding is invalid.",
  ARTIFACT_PRODUCER_NOT_ALLOWED: "Artifact producer is not allowed.",
  ARTIFACT_METADATA_INVALID: "Artifact metadata is invalid.",
  ARTIFACT_LIMIT_EXCEEDED: "Artifact limit was exceeded.",
  ARTIFACT_QUOTA_EXCEEDED: "Artifact quota was exceeded.",
  ARTIFACT_ID_GENERATION_FAILED: "Artifact identity generation failed.",
  ARTIFACT_KEY_CONFLICT: "Artifact key conflicts with durable content.",
  ARTIFACT_STORE_CORRUPTED: "Artifact store integrity validation failed.",
  ARTIFACT_LOCK_FAILED: "Artifact store lock could not be acquired.",
  ARTIFACT_WRITE_FAILED: "Artifact store write failed.",
  ARTIFACT_READ_FAILED: "Artifact store read failed.",
});

export const ARTIFACT_ERROR_CODES = Object.freeze(Object.keys(MESSAGES));

export class CapturedArtifactError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) throw new TypeError("Unknown artifact error code");
    super(MESSAGES[code]);
    this.name = "CapturedArtifactError";
    this.code = code;
  }
}

export function artifactError(code) {
  return new CapturedArtifactError(code);
}

export function isCapturedArtifactError(error) {
  return error instanceof CapturedArtifactError;
}
