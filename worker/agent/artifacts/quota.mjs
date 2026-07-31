import { artifactError } from "./errors.mjs";
import {
  MAX_ARTIFACTS_PER_OPERATION,
  MAX_ARTIFACTS_PER_RUN,
  MAX_ARTIFACTS_PER_SESSION,
  MAX_ARTIFACTS_PER_TARGET,
  MAX_CONTENT_BYTES_PER_RUN,
  MAX_CONTENT_BYTES_PER_SESSION,
  MAX_CONTENT_BYTES_PER_TARGET,
} from "./schema.mjs";

function validUsage(value) {
  return value
    && Number.isSafeInteger(value.count)
    && value.count >= 0
    && Number.isSafeInteger(value.contentBytes)
    && value.contentBytes >= 0;
}

export function enforceArtifactQuota({ session, run, target, operation }, contentBytes) {
  if (
    !validUsage(session)
    || !validUsage(run)
    || !validUsage(target)
    || !validUsage(operation)
    || !Number.isSafeInteger(contentBytes)
    || contentBytes < 0
  ) {
    throw new TypeError("Artifact quota usage is invalid");
  }
  if (
    session.count + 1 > MAX_ARTIFACTS_PER_SESSION
    || session.contentBytes + contentBytes > MAX_CONTENT_BYTES_PER_SESSION
    || run.count + 1 > MAX_ARTIFACTS_PER_RUN
    || run.contentBytes + contentBytes > MAX_CONTENT_BYTES_PER_RUN
    || target.count + 1 > MAX_ARTIFACTS_PER_TARGET
    || target.contentBytes + contentBytes > MAX_CONTENT_BYTES_PER_TARGET
    || operation.count + 1 > MAX_ARTIFACTS_PER_OPERATION
  ) {
    throw artifactError("ARTIFACT_QUOTA_EXCEEDED");
  }
}
