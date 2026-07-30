export function expectedReadTargets({ expectedA, expectedB, readPhase }) {
  if (typeof expectedA !== "string" || expectedA === "" || !["a-only", "all"].includes(readPhase)) {
    throw new TypeError("invalid Reviewer oracle read policy input");
  }
  if (expectedB === "-") return Object.freeze([expectedA]);
  if (typeof expectedB !== "string" || expectedB === "") {
    throw new TypeError("invalid Reviewer oracle second target");
  }
  return Object.freeze(readPhase === "all" ? [expectedA, expectedB] : [expectedA]);
}
