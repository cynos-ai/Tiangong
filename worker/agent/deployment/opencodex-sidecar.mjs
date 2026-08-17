import { canonicalJson, sha256 } from "../canonical-json.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const CREDENTIAL_REF = /^agentteams:\/\/credentials\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PHASES = new Set(["absent", "provisioning", "ready", "rotating", "draining", "drained", "removed"]);
const REQUIRED_BINDING_KEYS = [
  "bridge", "credentialRef", "credentialSource", "endpoint", "generation", "image",
  "model", "provider", "schemaVersion", "teamId", "transport", "workerId",
];
const REQUIRED_SNAPSHOT_KEYS = ["binding", "events", "phase", "schemaVersion", "sidecarId"];

export const OPENCODEX_SIDECAR_SCHEMA_VERSION = 1;
export const OPENCODEX_SIDECAR_BRIDGE = "opencodex";
export const OPENCODEX_SIDECAR_TRANSPORT = "responses-via-chat-bridge";
export const OPENCODEX_SIDECAR_CREDENTIAL_SOURCE = "agentteams-secret-projection";

export class OpenCodexSidecarError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenCodexSidecarError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OpenCodexSidecarError(code, message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    fail("invalid-schema", `${label} has missing or unknown fields.`);
  }
}

function stringField(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail("invalid-binding", `${label} has an invalid format.`);
  return value;
}

function integerField(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) fail("invalid-binding", `${label} has an invalid value.`);
  return value;
}

function internalEndpoint(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail("invalid-binding", "The OpenCodex endpoint must be an absolute URL."); }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !HOST.test(parsed.hostname) || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    fail("invalid-binding", "The OpenCodex endpoint must be a credential-free internal HTTP origin.");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function validateBinding(value) {
  exactKeys(value, REQUIRED_BINDING_KEYS, "OpenCodex sidecar binding");
  if (value.schemaVersion !== OPENCODEX_SIDECAR_SCHEMA_VERSION ||
      value.credentialSource !== OPENCODEX_SIDECAR_CREDENTIAL_SOURCE ||
      value.transport !== OPENCODEX_SIDECAR_TRANSPORT || value.bridge !== OPENCODEX_SIDECAR_BRIDGE) {
    fail("invalid-binding", "The OpenCodex sidecar binding selects an unsupported contract.");
  }
  return Object.freeze({
    schemaVersion: OPENCODEX_SIDECAR_SCHEMA_VERSION,
    teamId: stringField(value.teamId, ID, "teamId"),
    workerId: stringField(value.workerId, ID, "workerId"),
    image: stringField(value.image, IMAGE, "image"),
    endpoint: internalEndpoint(stringField(value.endpoint, /^https?:\/\//u, "endpoint")),
    provider: stringField(value.provider, ID, "provider"),
    model: stringField(value.model, MODEL, "model"),
    transport: OPENCODEX_SIDECAR_TRANSPORT,
    bridge: OPENCODEX_SIDECAR_BRIDGE,
    credentialSource: OPENCODEX_SIDECAR_CREDENTIAL_SOURCE,
    credentialRef: stringField(value.credentialRef, CREDENTIAL_REF, "credentialRef"),
    generation: integerField(value.generation, "generation"),
  });
}

function validateSidecarId(value) {
  return stringField(value, ID, "sidecarId");
}

function validateProbe(value, binding) {
  exactKeys(value, ["generation", "healthz", "model", "provider", "readyz"], "OpenCodex readiness probe");
  if (value.healthz !== "pass" || value.readyz !== "pass" || value.model !== binding.model || value.provider !== binding.provider || value.generation !== binding.generation) {
    fail("sidecar-not-ready", "The OpenCodex sidecar readiness probe did not match the bound route.");
  }
  return Object.freeze({ generation: binding.generation, healthz: "pass", readyz: "pass", model: binding.model, provider: binding.provider });
}

function validateOperationReceipt(value, expectedGeneration, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.status !== "pass" || value.generation !== expectedGeneration) {
    fail("sidecar-adapter-invalid", `${label} returned an invalid receipt.`);
  }
  return Object.freeze({ status: "pass", generation: expectedGeneration });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateDigest(state) {
  return sha256(canonicalJson(state));
}

function assertPhase(actual, expected, action) {
  if (actual !== expected) fail("sidecar-phase-invalid", `Cannot ${action} an OpenCodex sidecar in phase ${actual}; expected ${expected}.`);
}

function assertNoSecretFields(value, label) {
  const forbiddenKey = /^(?:api[_-]?key|access[_-]?token|password|authorization|bearer|token)$/iu;
  const secretValue = /^(?:bearer\s+|sk-[A-Za-z0-9])/iu;
  const visit = (current) => {
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (!current || typeof current !== "object") {
      if (typeof current === "string" && secretValue.test(current)) fail("sidecar-secret-bearing-state", `${label} contains a credential value.`);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (forbiddenKey.test(key)) fail("sidecar-secret-bearing-state", `${label} contains a credential-bearing field.`);
      visit(child);
    }
  };
  visit(value);
}

function snapshotValue({ binding, sidecarId, phase, events }) {
  const snapshot = {
    schemaVersion: OPENCODEX_SIDECAR_SCHEMA_VERSION,
    sidecarId,
    binding: binding ? Object.freeze({ ...binding }) : null,
    phase,
    events: Object.freeze(events.map((event) => Object.freeze({ ...event }))),
  };
  assertNoSecretFields(snapshot, "OpenCodex sidecar snapshot");
  return Object.freeze(snapshot);
}

/**
 * Controller-side contract for an AgentTeams-owned OpenCodex sidecar.
 *
 * The adapter is intentionally opaque: it receives only a sanitized binding
 * and credential reference. It never receives an upstream provider key or a
 * Worker Docker socket. Failed external calls leave the controller in the
 * in-flight phase so recovery cannot silently fall back to another route.
 */
export class OpenCodexSidecarController {
  #adapter;
  #clock;
  #binding;
  #sidecarId;
  #phase;
  #events;

  constructor({ adapter, clock = () => new Date().toISOString(), snapshot } = {}) {
    if (!adapter || typeof adapter.provision !== "function" || typeof adapter.probe !== "function" ||
        typeof adapter.status !== "function" || typeof adapter.rotate !== "function" ||
        typeof adapter.drain !== "function" || typeof adapter.remove !== "function") {
      throw new TypeError("OpenCodex sidecar adapter must implement provision, probe, status, rotate, drain, and remove.");
    }
    if (typeof clock !== "function") throw new TypeError("OpenCodex sidecar clock must be a function.");
    this.#adapter = adapter;
    this.#clock = clock;
    this.#binding = undefined;
    this.#sidecarId = undefined;
    this.#phase = "absent";
    this.#events = [];
    if (snapshot !== undefined) this.#restore(snapshot);
  }

  #restore(value) {
    exactKeys(value, REQUIRED_SNAPSHOT_KEYS, "OpenCodex sidecar snapshot");
    if (value.schemaVersion !== OPENCODEX_SIDECAR_SCHEMA_VERSION || !PHASES.has(value.phase) || !Array.isArray(value.events)) {
      fail("invalid-snapshot", "The OpenCodex sidecar snapshot is invalid.");
    }
    const binding = value.phase === "absent" || value.phase === "removed" ? undefined : validateBinding(value.binding);
    if ((value.phase !== "absent" && value.phase !== "removed") && !binding) fail("invalid-snapshot", "A live sidecar snapshot requires a binding.");
    if (value.phase === "absent" && value.binding !== null) fail("invalid-snapshot", "An absent sidecar snapshot must not retain a binding.");
    if (value.phase === "removed" && value.binding !== null) fail("invalid-snapshot", "A removed sidecar snapshot must not retain a binding.");
    if (value.phase === "absent" && value.sidecarId !== null) fail("invalid-snapshot", "An absent sidecar snapshot must not retain an id.");
    if (value.phase !== "absent" && value.phase !== "removed") validateSidecarId(value.sidecarId);
    assertNoSecretFields(value, "OpenCodex sidecar snapshot");
    this.#binding = binding;
    this.#sidecarId = value.sidecarId === null ? undefined : value.sidecarId;
    this.#phase = value.phase;
    this.#events = value.events.map((event) => clone(event));
  }

  #event(action, outcome, details = {}) {
    const event = Object.freeze({
      action,
      outcome,
      phase: this.#phase,
      generation: this.#binding?.generation ?? null,
      sidecarId: this.#sidecarId ?? null,
      at: this.#clock(),
      ...details,
    });
    assertNoSecretFields(event, "OpenCodex sidecar event");
    this.#events.push(event);
    return event;
  }

  get phase() { return this.#phase; }

  snapshot() {
    return snapshotValue({ binding: this.#binding ?? null, sidecarId: this.#sidecarId ?? null, phase: this.#phase, events: this.#events });
  }

  receipt() {
    const snapshot = this.snapshot();
    return Object.freeze({
      schemaVersion: snapshot.schemaVersion,
      sidecarId: snapshot.sidecarId,
      phase: snapshot.phase,
      generation: snapshot.binding?.generation ?? null,
      endpoint: snapshot.binding?.endpoint ?? null,
      provider: snapshot.binding?.provider ?? null,
      model: snapshot.binding?.model ?? null,
      transport: snapshot.binding?.transport ?? null,
      bridge: snapshot.binding?.bridge ?? null,
      credentialSource: snapshot.binding?.credentialSource ?? null,
      routeDigest: snapshot.binding ? stateDigest({ provider: snapshot.binding.provider, model: snapshot.binding.model, transport: snapshot.binding.transport, bridge: snapshot.binding.bridge }) : null,
    });
  }

  async provision(bindingInput) {
    const binding = validateBinding(bindingInput);
    if (this.#phase === "provisioning" || this.#phase === "ready" || this.#phase === "rotating" || this.#phase === "draining" || this.#phase === "drained") {
      if (canonicalJson(this.#binding) === canonicalJson(binding)) return Object.freeze({ replayed: true, receipt: this.receipt() });
      fail("sidecar-binding-conflict", "A different OpenCodex sidecar binding is already active.");
    }
    if (this.#phase === "removed") fail("sidecar-removed", "A removed OpenCodex sidecar cannot be provisioned again.");
    this.#binding = binding;
    this.#phase = "provisioning";
    this.#event("provision", "started");
    let result;
    try {
      result = await this.#adapter.provision(clone(binding));
      if (!result || typeof result !== "object" || Array.isArray(result)) fail("sidecar-adapter-invalid", "The sidecar provision adapter returned an invalid receipt.");
      exactKeys(result, ["endpoint", "image", "sidecarId"], "OpenCodex provision receipt");
      if (result.endpoint !== binding.endpoint || result.image !== binding.image) fail("sidecar-adapter-invalid", "The provision receipt does not match the binding.");
      this.#sidecarId = validateSidecarId(result.sidecarId);
      this.#event("provision", "pass");
      return Object.freeze({ replayed: false, receipt: this.receipt() });
    } catch (error) {
      this.#event("provision", "uncertain", { code: error?.code === "sidecar-adapter-invalid" ? error.code : "sidecar-provision-uncertain" });
      throw error;
    }
  }

  async ready() {
    assertPhase(this.#phase, "provisioning", "mark ready");
    this.#event("ready", "started");
    try {
      const probe = validateProbe(await this.#adapter.probe({ sidecarId: this.#sidecarId, binding: clone(this.#binding) }), this.#binding);
      this.#phase = "ready";
      this.#event("ready", "pass", probe);
      return Object.freeze({ replayed: false, receipt: this.receipt() });
    } catch (error) {
      this.#event("ready", "failed", { code: error?.code === "sidecar-not-ready" ? error.code : "sidecar-readiness-uncertain" });
      throw error;
    }
  }

  async reconcile() {
    if (!["provisioning", "ready", "rotating", "draining", "drained"].includes(this.#phase)) {
      fail("sidecar-phase-invalid", `Cannot reconcile an OpenCodex sidecar in phase ${this.#phase}.`);
    }
    const observed = await this.#adapter.status({ sidecarId: this.#sidecarId, binding: clone(this.#binding) });
    exactKeys(observed, ["generation", "phase"], "OpenCodex sidecar status");
    integerField(observed.generation, "generation");
    if (!["provisioning", "ready", "rotating", "draining", "drained", "removed"].includes(observed.phase)) {
      fail("sidecar-adapter-invalid", "The OpenCodex sidecar status has an invalid phase.");
    }
    if (observed.phase !== "removed" && observed.generation !== this.#binding.generation) {
      fail("sidecar-generation-invalid", "The observed sidecar generation does not match the bound generation.");
    }
    if (observed.phase === "removed") {
      this.#phase = "removed";
      this.#binding = undefined;
      this.#sidecarId = undefined;
    } else {
      this.#phase = observed.phase;
    }
    this.#event("reconcile", "pass", { observedPhase: observed.phase, observedGeneration: observed.generation });
    return Object.freeze({ replayed: false, receipt: this.receipt() });
  }

  async rotate({ credentialRef, generation } = {}) {
    assertPhase(this.#phase, "ready", "rotate");
    const nextCredentialRef = stringField(credentialRef, CREDENTIAL_REF, "credentialRef");
    const nextGeneration = integerField(generation, "generation");
    if (nextGeneration !== this.#binding.generation + 1) fail("sidecar-generation-invalid", "A credential rotation must advance the generation by exactly one.");
    if (nextCredentialRef === this.#binding.credentialRef) fail("sidecar-credential-reused", "A credential rotation must use a new AgentTeams secret reference.");
    const previousBinding = this.#binding;
    this.#phase = "rotating";
    this.#binding = Object.freeze({ ...previousBinding, credentialRef: nextCredentialRef, generation: nextGeneration });
    this.#event("rotate", "started");
    try {
      validateOperationReceipt(await this.#adapter.rotate({ sidecarId: this.#sidecarId, credentialRef: nextCredentialRef, generation: nextGeneration }), nextGeneration, "OpenCodex rotate adapter");
      const probe = validateProbe(await this.#adapter.probe({ sidecarId: this.#sidecarId, binding: clone(this.#binding) }), this.#binding);
      this.#phase = "ready";
      this.#event("rotate", "pass", probe);
      return Object.freeze({ replayed: false, receipt: this.receipt() });
    } catch (error) {
      this.#event("rotate", "uncertain", { code: "sidecar-rotation-recovery-needed" });
      throw error;
    }
  }

  async drain() {
    assertPhase(this.#phase, "ready", "drain");
    this.#phase = "draining";
    this.#event("drain", "started");
    try {
      validateOperationReceipt(await this.#adapter.drain({ sidecarId: this.#sidecarId, binding: clone(this.#binding) }), this.#binding.generation, "OpenCodex drain adapter");
      this.#phase = "drained";
      this.#event("drain", "pass");
      return Object.freeze({ replayed: false, receipt: this.receipt() });
    } catch (error) {
      this.#event("drain", "uncertain", { code: "sidecar-drain-recovery-needed" });
      throw error;
    }
  }

  async remove() {
    assertPhase(this.#phase, "drained", "remove");
    this.#event("remove", "started");
    try {
      validateOperationReceipt(await this.#adapter.remove({ sidecarId: this.#sidecarId }), this.#binding.generation, "OpenCodex remove adapter");
      this.#phase = "removed";
      this.#binding = undefined;
      this.#sidecarId = undefined;
      this.#event("remove", "pass");
      return Object.freeze({ replayed: false, receipt: this.receipt() });
    } catch (error) {
      this.#event("remove", "uncertain", { code: "sidecar-remove-recovery-needed" });
      throw error;
    }
  }
}

export function validateOpenCodexSidecarBinding(value) {
  return validateBinding(value);
}

export function validateOpenCodexSidecarReceipt(value, { endpoint, provider, model } = {}) {
  exactKeys(value, ["bridge", "credentialSource", "endpoint", "generation", "model", "phase", "provider", "routeDigest", "schemaVersion", "sidecarId", "transport"], "OpenCodex sidecar readiness receipt");
  if (value.schemaVersion !== OPENCODEX_SIDECAR_SCHEMA_VERSION || value.phase !== "ready" ||
      value.transport !== OPENCODEX_SIDECAR_TRANSPORT || value.bridge !== OPENCODEX_SIDECAR_BRIDGE ||
      value.credentialSource !== OPENCODEX_SIDECAR_CREDENTIAL_SOURCE || !DIGEST.test(value.routeDigest ?? "")) {
    fail("sidecar-not-ready", "The OpenCodex sidecar readiness receipt is not ready for use.");
  }
  const receipt = {
    ...value,
    endpoint: internalEndpoint(stringField(value.endpoint, /^https?:\/\//u, "endpoint")),
    provider: stringField(value.provider, ID, "provider"),
    model: stringField(value.model, MODEL, "model"),
    sidecarId: validateSidecarId(value.sidecarId),
    generation: integerField(value.generation, "generation"),
  };
  if ((endpoint && receipt.endpoint !== endpoint) || (provider && receipt.provider !== provider) || (model && receipt.model !== model)) {
    fail("sidecar-route-mismatch", "The OpenCodex sidecar readiness receipt does not match the selected route.");
  }
  assertNoSecretFields(receipt, "OpenCodex sidecar readiness receipt");
  return Object.freeze(receipt);
}

export function isOpenCodexSidecarSnapshot(value) {
  try {
    const controller = new OpenCodexSidecarController({
      adapter: { provision() {}, probe() {}, status() {}, rotate() {}, drain() {}, remove() {} },
      snapshot: value,
    });
    controller.snapshot();
    return true;
  } catch {
    return false;
  }
}
