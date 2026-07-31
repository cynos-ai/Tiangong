const STATE_TOOLS = new Set(["start_work", "extend_scope", "check_completion", "abandon_work"]);

export class ReviewerPracticeGate {
  #profileDigest;
  #toolIds;

  constructor({ profileBundle }) {
    if (!Object.isFrozen(profileBundle) || profileBundle.profile?.roleId !== "reviewer") {
      throw new TypeError("ReviewerPracticeGate requires the validated Reviewer profile");
    }
    this.#profileDigest = profileBundle.profileDigest;
    this.#toolIds = new Set(profileBundle.profile.toolIds);
  }

  async evaluate(context) {
    const operation = context?.operation;
    const common = operation?.roleId === "reviewer" && operation.profileDigest === this.#profileDigest &&
      operation.practiceId === "review" && operation.practiceVersion === 1 &&
      this.#toolIds.has(operation.toolName);
    const stateAllowed = common && operation.policyVersion === "practice-run-v1" &&
      operation.category === "state-transition" && STATE_TOOLS.has(operation.toolName);
    const readAllowed = common && operation.policyVersion === "review-read-v1" &&
      operation.category === "read-only" && operation.toolName === "read" &&
      typeof operation.state?.runId === "string" &&
      Number.isSafeInteger(operation.state?.expectedRunRevision);
    if (stateAllowed || readAllowed) return { kind: "allow" };
    return {
      kind: "deny",
      reason: "tool is not authorized by the Reviewer practice policy",
      reasonCode: "TOOL_NOT_AUTHORIZED",
    };
  }
}
