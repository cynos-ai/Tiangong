const STATE_TOOLS = new Set(["start_work", "extend_scope", "check_completion", "abandon_work"]);
const EFFECTS = Object.freeze({
  localRead: true,
  workspaceMutation: false,
  networkEgress: false,
  modelInference: false,
  costBearing: false,
});

function exactEffects(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === Object.keys(EFFECTS).sort().join(",")
    && Object.entries(EFFECTS).every(([key, expected]) => value[key] === expected);
}

export class ReviewerPracticeGate {
  #profileDigest;
  #toolIds;

  constructor({ profileBundle }) {
    if (!Object.isFrozen(profileBundle) || profileBundle.profile?.roleId !== "reviewer"
        || profileBundle.profile.gatePolicyId !== "reviewer-v2") {
      throw new TypeError("ReviewerPracticeGate requires the validated Reviewer v2 profile");
    }
    this.#profileDigest = profileBundle.profileDigest;
    this.#toolIds = new Set(profileBundle.profile.toolIds);
  }

  async evaluate(context) {
    const operation = context?.operation;
    const common = operation?.roleId === "reviewer" && operation.profileDigest === this.#profileDigest
      && operation.practiceId === "review" && operation.practiceVersion === 2
      && this.#toolIds.has(operation.toolName) && exactEffects(operation.effects)
      && typeof operation.workspaceScope === "string" && /^[a-f0-9]{64}$/u.test(operation.workspaceScope);
    const stateAllowed = common && operation.policyVersion === "practice-run-v2"
      && operation.category === "state-transition" && STATE_TOOLS.has(operation.toolName);
    const targetState = typeof operation?.state?.runId === "string"
      && Number.isSafeInteger(operation?.state?.expectedRunRevision)
      && typeof operation?.state?.targetId === "string";
    const readAllowed = common && targetState && operation.policyVersion === "review-target-consume-v2"
      && operation.category === "read-only" && operation.toolName === "read";
    const inspectionAllowed = common && targetState && operation.category === "read-only"
      && ((operation.policyVersion === "review-directory-inspect-v1" && operation.toolName === "inspect_directory")
        || (operation.policyVersion === "review-git-inspect-v1" && operation.toolName === "inspect_repository"));
    if (stateAllowed || readAllowed || inspectionAllowed) return { kind: "allow" };
    return {
      kind: "deny",
      reason: "tool is not authorized by the Reviewer practice policy",
      reasonCode: "TOOL_NOT_AUTHORIZED",
    };
  }
}
