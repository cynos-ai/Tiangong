const PR3_TOOLS = new Set(["start_work", "extend_scope", "abandon_work"]);

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
    const allowed = operation?.policyVersion === "practice-run-v1" &&
      operation.category === "state-transition" && operation.roleId === "reviewer" &&
      operation.profileDigest === this.#profileDigest && operation.practiceId === "review" &&
      operation.practiceVersion === 1 &&
      PR3_TOOLS.has(operation.toolName) &&
      this.#toolIds.has(operation.toolName);
    if (allowed) return { kind: "allow" };
    return {
      kind: "deny",
      reason: "tool is not authorized by the Reviewer practice policy",
      reasonCode: "TOOL_NOT_AUTHORIZED",
    };
  }
}
