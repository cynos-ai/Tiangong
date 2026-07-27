import { normalizeReplyTarget } from "./turn-contract.mjs";

const CONTROL_MARKER = /TG_PEER_[A-Z]+/gu;
const CONTROL_COMMAND = /(?:^|\s)TG_PEER_(START|PING|PONG)\s+nonce=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[.!?]?\s|[.!?]?$)/gu;
const MAX_SEEN_TURNS = 64;

function requireMatrixActor(request) {
  if (request?.actor?.channel !== "matrix" || typeof request.actor.id !== "string") {
    throw new Error("Peer transport control requires an authenticated Matrix actor");
  }
}

export function parsePeerTransportCommand(text) {
  if (typeof text !== "string") throw new TypeError("Peer transport input must be a string");
  const markers = [...text.matchAll(CONTROL_MARKER)];
  if (markers.length === 0) return null;
  const commands = [...text.matchAll(CONTROL_COMMAND)];
  if (markers.length !== 1 || commands.length !== 1) {
    throw new Error("Peer transport control is malformed or ambiguous");
  }
  return Object.freeze({
    kind: commands[0][1].toLowerCase(),
    nonce: commands[0][2],
  });
}

export class PeerTransportProbe {
  #pending = new Map();
  #planned = new WeakSet();
  #seenOrder = [];
  #seenTurns = new Set();

  get pendingCount() {
    return this.#pending.size;
  }

  plan(command, request, route) {
    if (!command || typeof command !== "object") throw new TypeError("Peer transport command is required");
    requireMatrixActor(request);
    if (this.#seenTurns.has(request.turnId)) throw new Error("Peer transport turn was already consumed");

    const sender = normalizeReplyTarget(request.replyTarget);
    const peers = request.authorizedPeerTargets;
    if (!Array.isArray(peers)) throw new Error("Authorized peer targets are unavailable");

    let replyTarget;
    let text;
    let transition;
    if (command.kind === "start") {
      if (sender !== null) throw new Error("Peer transport start must not originate from a peer");
      if (peers.length !== 1) throw new Error("Peer transport start requires exactly one authorized peer");
      if (this.#pending.size !== 0) throw new Error("Peer transport probe already has a pending peer");
      replyTarget = peers[0];
      text = `TG_PEER_PING nonce=${command.nonce}`;
      transition = Object.freeze({ action: "add", peerId: replyTarget.id, nonce: command.nonce });
    } else if (command.kind === "ping") {
      if (!sender || route?.replyTarget?.id !== sender.id) {
        throw new Error("Peer transport ping requires an authenticated reply route");
      }
      replyTarget = route.replyTarget;
      text = `TG_PEER_PONG nonce=${command.nonce}`;
      transition = Object.freeze({ action: "none" });
    } else if (command.kind === "pong") {
      if (!sender || route?.expectedPeerId !== sender.id || this.#pending.get(sender.id) !== command.nonce) {
        throw new Error("Peer transport pong does not match the pending peer and nonce");
      }
      replyTarget = null;
      text = `TG_PEER_DONE nonce=${command.nonce}`;
      transition = Object.freeze({ action: "delete", peerId: sender.id, nonce: command.nonce });
    } else {
      throw new Error("Unsupported peer transport control");
    }

    const plan = Object.freeze({
      turnId: request.turnId,
      command,
      replyTarget,
      text,
      transition,
    });
    this.#planned.add(plan);
    return plan;
  }

  commit(plan) {
    if (!plan || !this.#planned.has(plan)) throw new TypeError("Peer transport plan is invalid or consumed");
    this.#planned.delete(plan);
    if (plan.transition.action === "add") {
      this.#pending.set(plan.transition.peerId, plan.transition.nonce);
    } else if (plan.transition.action === "delete") {
      this.#pending.delete(plan.transition.peerId);
    }
    this.#seenTurns.add(plan.turnId);
    this.#seenOrder.push(plan.turnId);
    if (this.#seenOrder.length > MAX_SEEN_TURNS) {
      this.#seenTurns.delete(this.#seenOrder.shift());
    }
  }
}
