const MAX_READ_SEGMENTS_PER_FILE = 128;

function freezeFileFact(value) {
  return Object.freeze({ ...value });
}

function coverageFile({ path, index, status, reasonCode = null }) {
  return Object.freeze({
    path,
    targetRef: `scope-file-${index + 1}`,
    status,
    reasonCode,
  });
}

export function projectReviewReadCoverage(run, projection) {
  if (!run?.scope || !Array.isArray(run.scope.files) || !Array.isArray(projection?.executions)) {
    throw new TypeError("A materialized review run and Evidence projection are required");
  }

  const reads = projection.executions.filter((entry) => entry.toolName === "read");
  const byPath = new Map(run.scope.files.map((path) => [path, []]));
  for (const read of reads) {
    if (byPath.has(read.operation.target)) byPath.get(read.operation.target).push(read);
  }

  const files = [];
  const fileFactEntries = [];
  const selectedEventRefs = [];
  let firstReason = null;

  for (const [index, path] of run.scope.files.entries()) {
    const entries = byPath.get(path);
    if (entries.length === 0) {
      firstReason ??= "SCOPE_READ_INCOMPLETE";
      files.push(coverageFile({ path, index, status: "unread", reasonCode: "SCOPE_READ_INCOMPLETE" }));
      continue;
    }
    if (entries.length > MAX_READ_SEGMENTS_PER_FILE) {
      firstReason ??= "SCOPE_READ_INCOMPLETE";
      files.push(coverageFile({ path, index, status: "partial", reasonCode: "SCOPE_READ_INCOMPLETE" }));
      continue;
    }

    const versions = new Map();
    for (const entry of entries) {
      const key = `${entry.resultMetadata.fileDigest}:${entry.resultMetadata.fullFileLines}`;
      const group = versions.get(key) ?? [];
      group.push(entry);
      versions.set(key, group);
    }
    const selected = [...versions.values()].sort((left, right) =>
      right.at(-1).completedRef.sequence - left.at(-1).completedRef.sequence)[0];
    const total = selected[0].resultMetadata.fullFileLines;
    const intervals = selected
      .map((entry) => [entry.resultMetadata.returnedLineStart, entry.resultMetadata.returnedLineEnd])
      .sort((left, right) => left[0] - right[0]);
    let covered = 0;
    for (const [start, end] of intervals) {
      if (start > covered + 1) break;
      covered = Math.max(covered, end);
    }

    if (covered < total) {
      const mixed = versions.size > 1;
      const reasonCode = mixed ? "FILE_VERSION_MIXED" : "SCOPE_READ_INCOMPLETE";
      firstReason ??= reasonCode;
      files.push(coverageFile({
        path,
        index,
        status: mixed ? "mixed_version" : "partial",
        reasonCode,
      }));
      continue;
    }

    files.push(coverageFile({ path, index, status: "complete" }));
    fileFactEntries.push([path, freezeFileFact({
      fileDigest: selected[0].resultMetadata.fileDigest,
      fullFileLines: selected[0].resultMetadata.fullFileLines,
    })]);
    for (const entry of selected) selectedEventRefs.push(entry.startedRef, entry.completedRef);
  }

  return Object.freeze({
    satisfied: firstReason === null,
    reason: firstReason,
    files: Object.freeze(files),
    fileFacts: Object.freeze(Object.fromEntries(fileFactEntries)),
    selectedEventRefs: Object.freeze([...selectedEventRefs]),
  });
}
