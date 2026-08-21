const STORE = Symbol.for("tiangong.agentloop.correlation.v1");
const MAX_ENTRIES = 1024;
const MAX_AGE_MS = 30 * 60 * 1000;
const ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,256}$/u;
const FIELDS = Object.freeze({
  workId: "tiangong.work.id",
  taskId: "tiangong.task.id",
  memberId: "tiangong.member.id",
  sessionRef: "tiangong.session.ref",
  turnId: "tiangong.turn.id",
  skillId: "tiangong.skill.id",
  toolResultId: "tiangong.tool_result.id",
});

function state() {
  if (!globalThis[STORE]) globalThis[STORE] = { records: new Map(), toolCalls: new Map() };
  return globalThis[STORE];
}

function boundedId(value) {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

function contextKeys(ctx = {}) {
  return [...new Set([ctx.runId, ctx.sessionKey, ctx.sessionId].map(boundedId).filter(Boolean))];
}

function prune(now = Date.now()) {
  const current = state();
  for (const [key, record] of current.records) {
    if (now - record.updatedAt > MAX_AGE_MS) current.records.delete(key);
  }
  for (const [key, record] of current.toolCalls) {
    if (now - record.updatedAt > MAX_AGE_MS) current.toolCalls.delete(key);
  }
  while (current.records.size > MAX_ENTRIES) current.records.delete(current.records.keys().next().value);
  while (current.toolCalls.size > MAX_ENTRIES) current.toolCalls.delete(current.toolCalls.keys().next().value);
}

function normalized(values = {}) {
  const result = {};
  for (const field of Object.keys(FIELDS)) {
    const value = boundedId(values[field]);
    if (value) result[field] = value;
  }
  return result;
}

export function registerAgentLoopCorrelation(ctx = {}, values = {}) {
  const keys = contextKeys(ctx);
  if (!keys.length) return Object.freeze({});
  const current = state();
  const update = normalized(values);
  const updatedAt = Date.now();
  for (const key of keys) {
    const previous = current.records.get(key)?.values ?? {};
    current.records.set(key, { values: { ...previous, ...update }, updatedAt });
  }
  const toolCallId = boundedId(values.toolCallId ?? ctx.toolCallId);
  if (toolCallId) current.toolCalls.set(toolCallId, { keys, values: update, updatedAt });
  prune(updatedAt);
  return Object.freeze({ ...update });
}

export function correlationForContext(ctx = {}, toolCallId) {
  const current = state();
  const result = {};
  for (const key of contextKeys(ctx)) Object.assign(result, current.records.get(key)?.values ?? {});
  const call = current.toolCalls.get(boundedId(toolCallId));
  if (call) {
    Object.assign(result, call.values);
    for (const key of call.keys) Object.assign(result, current.records.get(key)?.values ?? {});
  }
  return Object.freeze(result);
}

export function correlationAttributes(values = {}) {
  const result = {};
  for (const [field, attribute] of Object.entries(FIELDS)) {
    const value = boundedId(values[field]);
    if (value) result[attribute] = value;
  }
  return Object.freeze(result);
}

export function correlationForSpan(span) {
  const attributes = span?.attributes ?? {};
  const current = state();
  const result = {};
  for (const key of [attributes["openclaw.run.id"], attributes["openclaw.session.id"], attributes["gen_ai.session.id"]].map(boundedId).filter(Boolean)) {
    Object.assign(result, current.records.get(key)?.values ?? {});
  }
  const toolCall = current.toolCalls.get(boundedId(attributes["gen_ai.tool.call.id"]));
  if (toolCall) {
    Object.assign(result, toolCall.values);
    for (const key of toolCall.keys) Object.assign(result, current.records.get(key)?.values ?? {});
  }
  return Object.freeze(result);
}

export function resetAgentLoopCorrelationForTest() {
  delete globalThis[STORE];
}
