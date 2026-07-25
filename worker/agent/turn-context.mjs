import { TurnGateState } from "./gates/turn-state.mjs";

export class TurnContextController {
  #active;

  begin({ sessionId, turnId, actor = null, resumed = false }) {
    if (this.#active) throw new Error("A Tiangong turn is already active");
    if (!sessionId || !turnId) throw new TypeError("sessionId and turnId are required");
    this.#active = {
      sessionId,
      turnId,
      actor: actor ? structuredClone(actor) : null,
      resumed: resumed === true,
      turnState: new TurnGateState(),
    };
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
