import { TurnGateState } from "./gates/turn-state.mjs";

export class TurnContextController {
  #active;

  begin({
    sessionId,
    turnId,
    actor = null,
    ingress = null,
    profileDigest = null,
    resumed = false,
    observability = null,
  }) {
    if (this.#active) throw new Error("A Tiangong turn is already active");
    if (!sessionId || !turnId) throw new TypeError("sessionId and turnId are required");
    if (profileDigest !== null && (typeof profileDigest !== "string" || profileDigest === "")) {
      throw new TypeError("profileDigest must be null or a non-empty string");
    }
    this.#active = Object.freeze({
      sessionId,
      turnId,
      actor: actor ? Object.freeze(structuredClone(actor)) : null,
      ingress: ingress ? Object.freeze(structuredClone(ingress)) : null,
      profileDigest,
      resumed: resumed === true,
      observability,
      turnState: new TurnGateState(),
    });
    return this.#active;
  }

  current = () => {
    if (!this.#active) throw new Error("No Tiangong turn is active");
    return this.#active;
  };

  end() {
    const completed = this.#active;
    this.#active = undefined;
    return completed;
  }
}
