function invalid(message) {
  throw new TypeError(message);
}

export function expectedReadTargets({ expectedA, expectedB, readPhase }) {
  if (typeof expectedA !== "string" || expectedA === "" ||
      !["a-only", "all", "all-at-least-once"].includes(readPhase)) {
    invalid("invalid Reviewer oracle read policy input");
  }
  if (expectedB === "-") return Object.freeze([expectedA]);
  if (typeof expectedB !== "string" || expectedB === "") {
    invalid("invalid Reviewer oracle second target");
  }
  return Object.freeze(readPhase === "a-only" ? [expectedA] : [expectedA, expectedB]);
}

export function validateReadExecutions({
  expectedA,
  expectedDigestA,
  expectedB,
  expectedDigestB,
  readPhase,
  executions,
}) {
  if (!Array.isArray(executions) || !["a-only", "all", "all-at-least-once", "safe-active"].includes(readPhase)) {
    invalid("invalid Reviewer read execution policy input");
  }
  const digestByTarget = new Map([[expectedA, expectedDigestA], [expectedB, expectedDigestB]]);
  const readsByTarget = new Map([...digestByTarget.keys()].map((target) => [
    target,
    executions.filter((execution) => execution.operation.target === target),
  ]));
  const isComplete = (execution, digest) =>
    execution.resultMetadata.fileDigest === digest &&
    execution.resultMetadata.truncated === false &&
    execution.resultMetadata.returnedLineStart === 1 &&
    execution.resultMetadata.returnedLineEnd === execution.resultMetadata.fullFileLines;
  let expectedTargets;
  if (readPhase === "safe-active") {
    if (expectedB === "-") invalid("safe-active requires A+B scope");
    if (executions.some((execution) => !digestByTarget.has(execution.operation.target) ||
        execution.resultMetadata.fileDigest !== digestByTarget.get(execution.operation.target))) {
      invalid("safe-active read escaped scope or changed fixture version");
    }
    if (!(readsByTarget.get(expectedA) ?? []).some((read) => isComplete(read, expectedDigestA))) {
      invalid("safe-active state lost the complete A read proof");
    }
    expectedTargets = [expectedA];
  } else {
    expectedTargets = [...expectedReadTargets({ expectedA, expectedB, readPhase })];
    for (const path of expectedTargets) {
      const reads = readsByTarget.get(path) ?? [];
      const countMatches = readPhase === "all-at-least-once" ? reads.length >= 1 : reads.length === 1;
      if (!countMatches || reads.some((read) => !isComplete(read, digestByTarget.get(path)))) {
        invalid(`complete single-version read proof is invalid for ${path}`);
      }
    }
    if (executions.some((execution) => !expectedTargets.includes(execution.operation.target)) ||
        (readPhase !== "all-at-least-once" && executions.length !== expectedTargets.length)) {
      invalid("unexpected read execution count");
    }
  }
  return Object.freeze({
    expectedTargets: Object.freeze(expectedTargets),
    readCountA: (readsByTarget.get(expectedA) ?? []).length,
    readCountB: expectedB === "-" ? 0 : (readsByTarget.get(expectedB) ?? []).length,
  });
}
