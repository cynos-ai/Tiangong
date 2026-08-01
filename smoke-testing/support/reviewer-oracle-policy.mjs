function fail(message) {
  throw new Error(message);
}

function validateTargets(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) fail("invalid Reviewer oracle target policy input");
  for (const target of value) {
    if (!target || typeof target.targetId !== "string" || !Array.isArray(target.resources) || target.resources.length !== 2) {
      fail("invalid Reviewer oracle target policy input");
    }
    for (const resource of target.resources) {
      if (!resource || !["one.txt", "two.txt"].includes(resource.memberPath)
          || typeof resource.contentDigest !== "string" || resource.contentDigest === "") {
        fail("invalid Reviewer oracle target policy input");
      }
    }
  }
}

export function expectedReadTargets({ targets, readPhase }) {
  validateTargets(targets);
  if (!["a-only", "all", "all-at-least-once", "safe-active"].includes(readPhase)) {
    fail("invalid Reviewer oracle read policy input");
  }
  return readPhase === "a-only" || readPhase === "safe-active" ? [targets[0]] : targets;
}

function completeExecution(execution, target, resource) {
  return execution?.status === "success" && execution.resource?.targetId === target.targetId
    && execution.resource?.memberPath === resource.memberPath
    && execution.resultMetadata?.fullContentDigest === resource.contentDigest
    && execution.resultMetadata?.returnedLineStart === 1
    && execution.resultMetadata?.returnedLineEnd === execution.resultMetadata?.fullContentLines
    && execution.resultMetadata?.truncated === false;
}

export function validateReadExecutions({ targets, readPhase, executions }) {
  const expected = expectedReadTargets({ targets, readPhase });
  if (!Array.isArray(executions)) fail("invalid Reviewer oracle read executions");
  for (const target of expected) {
    for (const resource of target.resources) {
      if (!executions.some((execution) => completeExecution(execution, target, resource))) {
        fail(`complete snapshot-bound read proof is invalid for ${resource.memberPath}`);
      }
    }
  }
  for (const execution of executions.filter((entry) => entry.status === "success")) {
    const target = targets.find((entry) => entry.targetId === execution.resource?.targetId);
    const resource = target?.resources.find((entry) => entry.memberPath === execution.resource?.memberPath);
    if (!target || !resource || execution.resultMetadata?.fullContentDigest !== resource.contentDigest) {
      fail("Reviewer read observed a changed or unauthorized fixture version");
    }
  }
  if (readPhase === "safe-active") {
    const second = targets[1];
    if (second) {
      for (const execution of executions.filter((entry) => entry.resource?.targetId === second.targetId)) {
        const resource = second.resources.find((entry) => entry.memberPath === execution.resource?.memberPath);
        if (!resource || execution.resultMetadata?.fullContentDigest !== resource.contentDigest) {
          fail("Reviewer read observed a changed fixture version");
        }
      }
    }
  }
  return {
    expectedTargetIds: expected.map((target) => target.targetId),
    readCountA: executions.filter((entry) => entry.resource?.targetId === targets[0].targetId).length,
    readCountB: targets[1]
      ? executions.filter((entry) => entry.resource?.targetId === targets[1].targetId).length : 0,
  };
}
