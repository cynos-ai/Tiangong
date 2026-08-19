import { readFile } from "node:fs/promises";

import {
  createContentRef,
  isContentRef,
  isControlProfile,
  isMemberConfig,
  isResult,
  isTaskSpec,
  isTeamConfig,
  isTeamRouteBinding,
  isWorkSpec,
} from "../../worker/agent/team/coordination-store.mjs";
import { canonicalJson, sha256 } from "../../worker/agent/canonical-json.mjs";

const SCHEMA = "tiangong_coordination";
const ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ERROR_CODE = /^[A-Z0-9_:-]{1,96}$/u;
const MAX_TIMELINE_ENTRIES = 4096;
const MAX_OUTBOX_ENTRIES = 1024;

function clone(value) { return structuredClone(value); }
function bounded(value, name, limit = 4096) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit || /[\u0000\r\n]/u.test(value)) throw new TypeError(`${name} is missing or exceeds the bounded limit`);
  return value;
}
function identifier(value, name) { const result = bounded(value, name, 160); if (!ID.test(result)) throw new TypeError(`${name} has an invalid identifier`); return result; }
function digest(value, name) { if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${name} must be a SHA-256 digest`); return value; }
function timestamp(value, name) { const result = bounded(value, name, 64); if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${name} must be an ISO timestamp`); return new Date(result).toISOString(); }
function json(value) { return value ?? null; }
function iso(value) { return new Date(value).toISOString(); }
function commandHash(scope, value) { return sha256({ scope, value }); }
function sessionFor(workId, teamId, routeId) { return `leader-${sha256({ workId, teamId, routeId }).slice(0, 48)}`; }
function taskSessionFor(task, teamId) { return `member-${sha256({ teamId, workId: task.workId, taskId: task.taskId, assigneeMemberId: task.assigneeMemberId }).slice(0, 48)}`; }
function workIdFor(teamId, routeId, eventId) { return `work-${sha256({ teamId, routeId, eventId }).slice(0, 48)}`; }
function dbError(error, fallback) { if (error?.code === "23505") return Object.assign(new Error(fallback), { code: fallback }); return error; }

async function transaction(pool, callback) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("PostgresCoordinationStore requires a pg-compatible pool");
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await callback(client); await client.query("COMMIT"); return result; }
  catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ } throw error; }
  finally { client.release(); }
}
function workRecord({ workId, teamId, routeId, roomId, title, actorId, sourceEventId, controlProfileId, leaderSessionId, createdAt }) {
  return Object.freeze({ kind: "tiangong.work", schemaVersion: 2, workId: identifier(workId, "workId"), teamId: identifier(teamId, "teamId"), routeId: identifier(routeId, "routeId"), roomId: bounded(roomId, "roomId", 256), title: bounded(title, "title", 160), actorId: bounded(actorId, "actorId", 256), sourceEventId: bounded(sourceEventId, "sourceEventId", 256), controlProfileId: identifier(controlProfileId, "controlProfileId"), leaderSessionId: identifier(leaderSessionId, "leaderSessionId"), createdAt: timestamp(createdAt, "createdAt") });
}
function timeline(row) {
  const payload = row.payload ?? {};
  return { sequence: Number(row.sequence), type: row.type, at: iso(row.occurred_at), actorId: payload.actorId ?? null, requestId: row.request_id ?? null, epoch: Number(row.epoch), payload: clone(payload) };
}
async function readTimeline(client, workId) {
  const { rows } = await client.query(`SELECT sequence,type,occurred_at,epoch,request_id,payload FROM ${SCHEMA}.work_timeline WHERE work_id=$1 ORDER BY sequence`, [workId]);
  return rows.map(timeline);
}
async function readWork(client, workId) {
  const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id=$1`, [workId]);
  if (!rows[0]) return undefined;
  const row = rows[0];
  return { work: clone(row.work_json), team: clone(row.team_json), route: clone(row.route_json), profile: clone(row.profile_json), epoch: Number(row.epoch), status: row.status, currentWorkSpec: row.current_work_spec ? clone(row.current_work_spec) : null, currentPlanRef: row.current_plan_ref ? clone(row.current_plan_ref) : null, timeline: await readTimeline(client, workId) };
}
function publicWork(entry) { return clone({ work: entry.work, epoch: entry.epoch, status: entry.status, currentWorkSpec: entry.currentWorkSpec, currentPlanRef: entry.currentPlanRef, timeline: entry.timeline }); }
function taskFrom(row) {
  if (!row) return undefined;
  const result = row.result_json ? clone(row.result_json) : null;
  const cancellation = row.cancellation_json ? clone(row.cancellation_json) : null;
  return { spec: clone(row.spec_json), sessionRef: row.session_ref, status: result ? "reported" : cancellation ? "cancelled" : "assigned", result, cancellation };
}
function wakeFrom(row) {
  return { wakeId: row.wake_id, ...(row.work_id ? { workId: row.work_id } : {}), ...(row.task_id ? { taskId: row.task_id } : {}), kind: row.kind, targetMemberId: row.target_member_id, status: row.status, ...(row.consumer_id ? { consumerId: row.consumer_id } : {}), ...(row.receipt_id ? { receiptId: row.receipt_id } : {}), createdAt: iso(row.created_at), ...(row.claimed_at ? { claimedAt: iso(row.claimed_at) } : {}), ...(row.acked_at ? { ackedAt: iso(row.acked_at) } : {}) };
}
function admissionFrom(row) {
  return { roomId: row.room_id, eventId: row.event_id, teamId: row.team_id, routeId: row.route_id, actorId: row.actor_id, status: row.status, ...(row.work_id ? { workId: row.work_id } : {}), attempts: Number(row.attempts), lastErrorCode: row.last_error_code ?? null, leaseOwner: row.lease_owner ?? null, leaseUntil: row.lease_until ? iso(row.lease_until) : null, receivedAt: iso(row.received_at), ...(row.routed_at ? { routedAt: iso(row.routed_at) } : {}) };
}
function bindingFrom(row) {
  if (!row) return undefined;
  return { roomId: row.room_id, eventId: row.event_id, workId: row.work_id, actorId: row.actor_id, associatedBy: row.associated_by, associatedAt: iso(row.associated_at), correctedAt: row.corrected_at ? iso(row.corrected_at) : null };
}
async function replayRow(client, requestId) {
  const { rows } = await client.query(`SELECT scope,request_hash,response_json FROM ${SCHEMA}.request_replay WHERE request_id=$1 FOR UPDATE`, [requestId]);
  return rows[0] ?? null;
}
async function checkReplay(client, requestId, scope, hash) {
  const row = await replayRow(client, requestId);
  if (!row) return null;
  if (row.scope !== scope || row.request_hash !== hash) throw new Error("COMMAND_REQUEST_CONFLICT");
  return clone(row.response_json);
}
async function saveReplay(client, requestId, scope, hash, response) {
  await client.query(`INSERT INTO ${SCHEMA}.request_replay(request_id,scope,request_hash,response_json) VALUES($1,$2,$3,$4::jsonb)`, [requestId, scope, hash, json(response)]);
}
async function nextSequence(client, workId) { const { rows } = await client.query(`SELECT COALESCE(MAX(sequence),0)+1 AS value FROM ${SCHEMA}.work_timeline WHERE work_id=$1`, [workId]); return Number(rows[0].value); }
async function ensureTimelineRoom(client, workId, profile) { const { rows } = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.work_timeline WHERE work_id=$1`, [workId]); if (Number(rows[0].count) >= Math.min(profile.maxTimelineEntries, MAX_TIMELINE_ENTRIES)) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED"); }
async function appendTimeline(client, { workId, type, at, epoch, requestId, actorId, payload }) {
  const sequence = await nextSequence(client, workId);
  await client.query(`INSERT INTO ${SCHEMA}.work_timeline(work_id,sequence,type,occurred_at,epoch,request_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [workId, sequence, type, at, epoch, requestId, json({ actorId, ...payload })]);
}
function normalizeGuard(result) {
  const value = result ?? {};
  for (const field of ["activeExecutions", "unresolvedOperations", "pendingApprovals", "unreadableContentRefs"]) if (!Array.isArray(value[field] ?? [])) throw new Error("CLOSE_GUARD_RESPONSE_INVALID");
  return { activeExecutions: value.activeExecutions ?? [], unresolvedOperations: value.unresolvedOperations ?? [], pendingApprovals: value.pendingApprovals ?? [], unreadableContentRefs: value.unreadableContentRefs ?? [] };
}

export class PostgresCoordinationStore {
  #pool; #now; #maxTimelineEntries; #maxOutboxEntries; #closeGuard; #cancellationGuard; #contentRefResolver;
  constructor({ pool, now = () => new Date().toISOString(), maxTimelineEntries = MAX_TIMELINE_ENTRIES, maxOutboxEntries = MAX_OUTBOX_ENTRIES, closeGuard, cancellationGuard, contentRefResolver } = {}) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("PostgresCoordinationStore pool is required");
    if (typeof now !== "function") throw new TypeError("PostgresCoordinationStore now must be a function");
    this.#pool = pool; this.#now = now; this.#maxTimelineEntries = maxTimelineEntries; this.#maxOutboxEntries = maxOutboxEntries;
    this.#closeGuard = closeGuard ?? { async inspect() { return {}; } };
    this.#cancellationGuard = cancellationGuard ?? { async stopAndInspect() { return { stopped: true, writerReleased: true, unresolvedOperations: [] }; } };
    this.#contentRefResolver = contentRefResolver;
  }
  async migrate({ sql } = {}) {
    const first = sql ?? await readFile(new URL("./migrations/001_coordination.sql", import.meta.url), "utf8");
    const second = sql ? "" : await readFile(new URL("./migrations/002_task_result.sql", import.meta.url), "utf8");
    return transaction(this.#pool, async (client) => { await client.query("SELECT pg_advisory_xact_lock(hashtext('tiangong_coordination.migrations'))"); await client.query(first); if (second) await client.query(second); return { version: second ? "002_task_result" : "001_coordination" }; });
  }

  async enqueueMessageAdmission({ team, route, profile, actorId, eventId, receivedAt = this.#now(), requestId } = {}) {
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile) || route.teamId !== team.teamId || team.controlProfileId !== profile.profileId) throw new Error("MESSAGE_ADMISSION_BINDING_MISMATCH");
    const request = identifier(requestId, "requestId"); const at = timestamp(receivedAt, "receivedAt");
    const payload = { roomId: route.roomId, eventId, teamId: team.teamId, routeId: route.routeId, actorId, receivedAt: at, profileId: profile.profileId };
    const hash = commandHash("message.admit", payload);
    return transaction(this.#pool, async (client) => {
      const replay = await checkReplay(client, request, "message.admit", hash);
      if (replay) {
        const current = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_admission WHERE room_id=$1 AND event_id=$2`, [route.roomId, eventId]);
        const binding = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_binding WHERE room_id=$1 AND event_id=$2`, [route.roomId, eventId]);
        return { replayed: true, admission: admissionFrom(current.rows[0]), binding: bindingFrom(binding.rows[0]) ?? null };
      }
      await client.query(`INSERT INTO ${SCHEMA}.matrix_message_admission(room_id,event_id,team_id,route_id,actor_id,status,received_at) VALUES($1,$2,$3,$4,$5,'pending',$6)`, [route.roomId, eventId, team.teamId, route.routeId, actorId, at]).catch((error) => { throw dbError(error, "MATRIX_MESSAGE_ALREADY_ADMITTED"); });
      const response = { replayed: false, admission: { roomId: route.roomId, eventId, teamId: team.teamId, routeId: route.routeId, actorId, status: "pending", attempts: 0, lastErrorCode: null, receivedAt: at }, binding: null };
      await saveReplay(client, request, "message.admit", hash, { admitted: true }); return response;
    });
  }

  async leaseMessageAdmission({ roomId, eventId, consumerId, leaseMs = 120_000 } = {}) {
    const consumer = identifier(consumerId, "consumerId");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) throw new Error("MESSAGE_ADMISSION_LEASE_INVALID");
    return transaction(this.#pool, async (client) => {
      const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_admission WHERE room_id=$1 AND event_id=$2 FOR UPDATE`, [roomId, eventId]); const row = rows[0];
      if (!row || row.status !== "pending") throw new Error("MESSAGE_ADMISSION_NOT_PENDING");
      const now = timestamp(this.#now(), "now");
      if (row.lease_owner && Date.parse(row.lease_until) > Date.parse(now)) {
        if (row.lease_owner !== consumer) throw new Error("MESSAGE_ADMISSION_LEASE_CONFLICT");
        return { replayed: true, admission: admissionFrom(row) };
      }
      const until = new Date(Date.parse(now) + leaseMs).toISOString();
      const updated = await client.query(`UPDATE ${SCHEMA}.matrix_message_admission SET lease_owner=$3,lease_until=$4,attempts=attempts+1 WHERE room_id=$1 AND event_id=$2 RETURNING *`, [roomId, eventId, consumer, until]);
      return { replayed: false, admission: admissionFrom(updated.rows[0]) };
    });
  }

  async recordAdmissionFailure({ roomId, eventId, errorCode, requestId } = {}) {
    const code = bounded(errorCode, "errorCode", 96); if (!ERROR_CODE.test(code)) throw new Error("ADMISSION_ERROR_CODE_INVALID");
    const request = identifier(requestId, "requestId"); const hash = commandHash("message.admit.failure", { roomId, eventId, errorCode: code });
    return transaction(this.#pool, async (client) => {
      const replay = await checkReplay(client, request, "message.admit.failure", hash);
      const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_admission WHERE room_id=$1 AND event_id=$2 FOR UPDATE`, [roomId, eventId]);
      if (!rows[0] || rows[0].status !== "pending") throw new Error("MESSAGE_ADMISSION_NOT_PENDING");
      if (replay) return { replayed: true, admission: admissionFrom(rows[0]) };
      const updated = await client.query(`UPDATE ${SCHEMA}.matrix_message_admission SET last_error_code=$3,lease_owner=NULL,lease_until=NULL WHERE room_id=$1 AND event_id=$2 RETURNING *`, [roomId, eventId, code]);
      await saveReplay(client, request, "message.admit.failure", hash, { recorded: true }); return { replayed: false, admission: admissionFrom(updated.rows[0]) };
    });
  }

  async routeMessage({ roomId, eventId, team, route, profile, actorId, expectedEpoch, requestId, targetWorkId, title, leaderSessionId } = {}) {
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile) || actorId !== team.leaderMemberId) throw new Error("MESSAGE_ROUTE_ACTOR_NOT_LEADER");
    if (route.roomId !== roomId || route.teamId !== team.teamId || team.controlProfileId !== profile.profileId) throw new Error("MESSAGE_ROUTE_BINDING_MISMATCH");
    const request = identifier(requestId, "requestId"); const target = targetWorkId ? identifier(targetWorkId, "targetWorkId") : null;
    const payload = { roomId, eventId, targetWorkId: target, title: title ?? null, actorId, expectedEpoch: expectedEpoch ?? null, profileId: profile.profileId };
    const hash = commandHash("message.route", payload);
    return transaction(this.#pool, async (client) => {
      const replay = await checkReplay(client, request, "message.route", hash);
      const admissionResult = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_admission WHERE room_id=$1 AND event_id=$2 FOR UPDATE`, [roomId, eventId]);
      const admission = admissionResult.rows[0]; if (!admission || admission.team_id !== team.teamId || admission.route_id !== route.routeId) throw new Error("MESSAGE_ADMISSION_NOT_FOUND");
      if (admission.lease_owner && admission.lease_owner !== actorId) throw new Error("MESSAGE_ADMISSION_LEASE_CONFLICT");
      if (replay || admission.status === "routed") {
        const bound = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_binding WHERE room_id=$1 AND event_id=$2`, [roomId, eventId]);
        const binding = bindingFrom(bound.rows[0]); if (!binding) throw new Error("COMMAND_REPLAY_STATE_MISSING");
        return { replayed: true, admission: admissionFrom(admission), binding, work: publicWork(await readWork(client, binding.workId)) };
      }
      const earlier = await client.query(`SELECT 1 FROM ${SCHEMA}.matrix_message_admission WHERE room_id=$1 AND status='pending' AND (received_at,event_id)<($2,$3) LIMIT 1`, [roomId, admission.received_at, eventId]);
      if (earlier.rows.length) throw new Error("MESSAGE_ROUTE_ORDER_CONFLICT");
      let entry; const at = timestamp(this.#now(), "now");
      if (target) {
        const locked = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id=$1 FOR UPDATE`, [target]); const row = locked.rows[0];
        if (!row || row.status !== "open" || row.team_id !== team.teamId || row.route_id !== route.routeId || row.control_profile_id !== profile.profileId || Number(row.epoch) !== expectedEpoch) throw new Error("MESSAGE_ROUTE_TARGET_CONFLICT");
        await ensureTimelineRoom(client, target, profile); const epoch = Number(row.epoch) + 1;
        await client.query(`UPDATE ${SCHEMA}.work SET epoch=$2,updated_at=$3 WHERE work_id=$1`, [target, epoch, at]);
        await appendTimeline(client, { workId: target, type: "matrix-message-associated", at, epoch, requestId: request, actorId, payload: { roomId, eventId, humanActorId: admission.actor_id } });
        entry = await readWork(client, target);
      } else {
        const id = workIdFor(team.teamId, route.routeId, eventId); const work = workRecord({ workId: id, teamId: team.teamId, routeId: route.routeId, roomId, title: bounded(title, "title", 160), actorId: admission.actor_id, sourceEventId: eventId, controlProfileId: profile.profileId, leaderSessionId: leaderSessionId ?? sessionFor(id, team.teamId, route.routeId), createdAt: iso(admission.received_at) });
        await client.query(`INSERT INTO ${SCHEMA}.work(work_id,team_id,route_id,room_id,actor_id,source_event_id,control_profile_id,leader_session_id,title,work_json,team_json,route_json,profile_json,current_work_spec,current_plan_ref,status,epoch,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,NULL,NULL,'open',0,$14,$14)`, [id, team.teamId, route.routeId, roomId, work.actorId, eventId, profile.profileId, work.leaderSessionId, work.title, json(work), json(team), json(route), json(profile), work.createdAt]);
        await appendTimeline(client, { workId: id, type: "work-created", at: work.createdAt, epoch: 0, requestId: request, actorId, payload: { work, source: { roomId, eventId, actorId: admission.actor_id } } });
        entry = await readWork(client, id);
      }
      await client.query(`INSERT INTO ${SCHEMA}.matrix_message_binding(room_id,event_id,work_id,actor_id,associated_by,associated_at) VALUES($1,$2,$3,$4,$5,$6)`, [roomId, eventId, entry.work.workId, admission.actor_id, actorId, at]);
      await client.query(`UPDATE ${SCHEMA}.matrix_message_admission SET status='routed',work_id=$3,routed_at=$4,lease_owner=NULL,lease_until=NULL WHERE room_id=$1 AND event_id=$2`, [roomId, eventId, entry.work.workId, at]);
      await saveReplay(client, request, "message.route", hash, { routed: true });
      return { replayed: false, admission: { ...admissionFrom(admission), status: "routed", workId: entry.work.workId, routedAt: at }, binding: { roomId, eventId, workId: entry.work.workId, actorId: admission.actor_id, associatedBy: actorId, associatedAt: at, correctedAt: null }, work: publicWork(entry) };
    });
  }

  async correctMessageAssociation({ roomId, eventId, correctionEventId, team, route, profile, actorId, expectedSourceEpoch, expectedTargetEpoch, requestId, targetWorkId, title, stopSourceIfEmpty = false } = {}) {
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile) || actorId !== team.leaderMemberId) throw new Error("MESSAGE_CORRECTION_ACTOR_NOT_LEADER");
    if (route.roomId !== roomId || route.teamId !== team.teamId || team.controlProfileId !== profile.profileId) throw new Error("MESSAGE_CORRECTION_BINDING_MISMATCH");
    const request = identifier(requestId, "requestId"); const requestedTarget = targetWorkId ? identifier(targetWorkId, "targetWorkId") : null;
    return transaction(this.#pool, async (client) => {
      const currentResult = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_binding WHERE room_id=$1 AND event_id=$2 FOR UPDATE`, [roomId, eventId]); const current = currentResult.rows[0];
      const correctionResult = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_admission WHERE room_id=$1 AND event_id=$2 FOR UPDATE`, [roomId, correctionEventId]); const correction = correctionResult.rows[0];
      if (!current || !correction || correction.status !== "pending") throw new Error("MESSAGE_CORRECTION_INPUT_INVALID");
      if (correction.lease_owner && correction.lease_owner !== actorId) throw new Error("MESSAGE_ADMISSION_LEASE_CONFLICT");
      const payload = { roomId, eventId, correctionEventId, sourceWorkId: current.work_id, targetWorkId: requestedTarget, title: title ?? null, actorId, expectedSourceEpoch, expectedTargetEpoch: expectedTargetEpoch ?? null, stopSourceIfEmpty };
      const hash = commandHash("message.correct", payload); const replay = await checkReplay(client, request, "message.correct", hash);
      if (replay) { const binding = bindingFrom((await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_binding WHERE room_id=$1 AND event_id=$2`, [roomId, eventId])).rows[0]); return { replayed: true, binding, sourceWork: publicWork(await readWork(client, current.work_id)), targetWork: publicWork(await readWork(client, binding.workId)) }; }
      let targetId = requestedTarget; let target; let source;
      if (targetId) {
        if (targetId === current.work_id) throw new Error("MESSAGE_CORRECTION_TARGET_CONFLICT");
        const locked = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id = ANY($1::text[]) ORDER BY work_id FOR UPDATE`, [[current.work_id, targetId].sort()]);
        const byId = new Map(locked.rows.map((row) => [row.work_id, row])); source = byId.get(current.work_id); target = byId.get(targetId);
        if (!source || source.status !== "open" || Number(source.epoch) !== expectedSourceEpoch) throw new Error("MESSAGE_CORRECTION_SOURCE_CONFLICT");
        if (!target || target.status !== "open" || target.team_id !== team.teamId || target.route_id !== route.routeId || Number(target.epoch) !== expectedTargetEpoch) throw new Error("MESSAGE_CORRECTION_TARGET_CONFLICT");
      } else {
        const sourceResult = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id=$1 FOR UPDATE`, [current.work_id]); source = sourceResult.rows[0];
        if (!source || source.status !== "open" || Number(source.epoch) !== expectedSourceEpoch) throw new Error("MESSAGE_CORRECTION_SOURCE_CONFLICT");
        targetId = workIdFor(team.teamId, route.routeId, correctionEventId);
        const work = workRecord({ workId: targetId, teamId: team.teamId, routeId: route.routeId, roomId, title: bounded(title, "title", 160), actorId: correction.actor_id, sourceEventId: correctionEventId, controlProfileId: profile.profileId, leaderSessionId: sessionFor(targetId, team.teamId, route.routeId), createdAt: iso(correction.received_at) });
        await client.query(`INSERT INTO ${SCHEMA}.work(work_id,team_id,route_id,room_id,actor_id,source_event_id,control_profile_id,leader_session_id,title,work_json,team_json,route_json,profile_json,current_work_spec,current_plan_ref,status,epoch,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,NULL,NULL,'open',0,$14,$14)`, [targetId, team.teamId, route.routeId, roomId, work.actorId, correctionEventId, profile.profileId, work.leaderSessionId, work.title, json(work), json(team), json(route), json(profile), work.createdAt]);
        await appendTimeline(client, { workId: targetId, type: "work-created", at: work.createdAt, epoch: 0, requestId: request, actorId, payload: { work, source: { roomId, eventId: correctionEventId, actorId: correction.actor_id } } });
        target = (await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id=$1 FOR UPDATE`, [targetId])).rows[0];
      }
      const count = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.task WHERE work_id=$1`, [source.work_id]);
      if (stopSourceIfEmpty) {
        if (Number(count.rows[0].count) > 0) throw new Error("MESSAGE_CORRECTION_SOURCE_NOT_EMPTY");
        const guard = normalizeGuard(await this.#closeGuard.inspect({ work: publicWork(await readWork(client, source.work_id)), tasks: [], resultRefs: [], action: "stop" }));
        if (guard.activeExecutions.length || guard.unresolvedOperations.length || guard.pendingApprovals.length || guard.unreadableContentRefs.length) throw new Error("MESSAGE_CORRECTION_SOURCE_NOT_EMPTY");
      }
      await ensureTimelineRoom(client, source.work_id, profile); await ensureTimelineRoom(client, targetId, profile);
      const at = timestamp(this.#now(), "now"); const sourceEpoch = Number(source.epoch) + 1; const targetEpoch = Number(target.epoch) + 1;
      const fact = { roomId, eventId, correctionEventId, sourceWorkId: source.work_id, targetWorkId: targetId, humanActorId: correction.actor_id };
      await client.query(`UPDATE ${SCHEMA}.work SET epoch=$2,status=$3,updated_at=$4 WHERE work_id=$1`, [source.work_id, sourceEpoch, stopSourceIfEmpty ? "stopped" : "open", at]);
      await client.query(`UPDATE ${SCHEMA}.work SET epoch=$2,updated_at=$3 WHERE work_id=$1`, [targetId, targetEpoch, at]);
      await appendTimeline(client, { workId: source.work_id, type: "message-association-corrected", at, epoch: sourceEpoch, requestId: request, actorId, payload: fact });
      await appendTimeline(client, { workId: targetId, type: "message-association-corrected", at, epoch: targetEpoch, requestId: request, actorId, payload: fact });
      if (stopSourceIfEmpty) await appendTimeline(client, { workId: source.work_id, type: "work-stopped", at, epoch: sourceEpoch, requestId: request, actorId, payload: { reason: `Message association corrected to ${targetId}` } });
      await client.query(`UPDATE ${SCHEMA}.matrix_message_binding SET work_id=$3,associated_by=$4,associated_at=$5,corrected_at=$5 WHERE room_id=$1 AND event_id=$2`, [roomId, eventId, targetId, actorId, at]);
      await client.query(`INSERT INTO ${SCHEMA}.matrix_message_binding(room_id,event_id,work_id,actor_id,associated_by,associated_at) VALUES($1,$2,$3,$4,$5,$6)`, [roomId, correctionEventId, targetId, correction.actor_id, actorId, at]);
      await client.query(`UPDATE ${SCHEMA}.matrix_message_admission SET status='routed',work_id=$3,routed_at=$4,lease_owner=NULL,lease_until=NULL WHERE room_id=$1 AND event_id=$2`, [roomId, correctionEventId, targetId, at]);
      await saveReplay(client, request, "message.correct", hash, { corrected: true });
      return { replayed: false, binding: { roomId, eventId, workId: targetId, actorId: current.actor_id, associatedBy: actorId, associatedAt: at, correctedAt: at }, sourceWork: publicWork(await readWork(client, source.work_id)), targetWork: publicWork(await readWork(client, targetId)) };
    });
  }

  async createWork({ workId, team, route, profile, spec = null, title = "Requirement pending", actorId, sourceEventId, requestId, leaderSessionId, wakes = [] } = {}) {
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile) || (spec !== null && !isWorkSpec(spec))) throw new Error("Work admission requires valid bindings and optional WorkSpec");
    const id = identifier(workId, "workId"); const request = identifier(requestId, "requestId"); const createdAt = spec?.createdAt ?? timestamp(this.#now(), "now");
    const work = workRecord({ workId: id, teamId: team.teamId, routeId: route.routeId, roomId: route.roomId, title, actorId, sourceEventId, controlProfileId: profile.profileId, leaderSessionId: leaderSessionId ?? sessionFor(id, team.teamId, route.routeId), createdAt });
    const hash = commandHash("work.create", { work, team, route, profile, spec });
    const created = await transaction(this.#pool, async (client) => {
      const replay = await checkReplay(client, request, "work.create", hash); if (replay) return { replayed: true, work: publicWork(await readWork(client, id)) };
      await client.query(`INSERT INTO ${SCHEMA}.work(work_id,team_id,route_id,room_id,actor_id,source_event_id,control_profile_id,leader_session_id,title,work_json,team_json,route_json,profile_json,current_work_spec,current_plan_ref,status,epoch,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,NULL,'open',0,$15,$15)`, [id, team.teamId, route.routeId, route.roomId, actorId, sourceEventId, profile.profileId, work.leaderSessionId, work.title, json(work), json(team), json(route), json(profile), json(spec), createdAt]).catch((error) => { throw dbError(error, "WORK_ALREADY_EXISTS"); });
      await appendTimeline(client, { workId: id, type: "work-created", at: createdAt, epoch: 0, requestId: request, actorId, payload: { work, source: { roomId: route.roomId, eventId: sourceEventId, actorId }, ...(spec ? { spec } : {}) } });
      await client.query(`INSERT INTO ${SCHEMA}.matrix_message_admission(room_id,event_id,team_id,route_id,actor_id,status,work_id,received_at,routed_at) VALUES($1,$2,$3,$4,$5,'routed',$6,$7,$7)`, [route.roomId, sourceEventId, team.teamId, route.routeId, actorId, id, createdAt]);
      await client.query(`INSERT INTO ${SCHEMA}.matrix_message_binding(room_id,event_id,work_id,actor_id,associated_by,associated_at) VALUES($1,$2,$3,$4,$5,$6)`, [route.roomId, sourceEventId, id, actorId, team.leaderMemberId, createdAt]);
      await saveReplay(client, request, "work.create", hash, { created: true }); return { replayed: false, work: publicWork(await readWork(client, id)) };
    });
    const wakeRecords = [];
    if (!created.replayed) for (const wake of wakes) wakeRecords.push((await this.enqueueWake({ workId: id, targetMemberId: wake.targetMemberId, kind: wake.kind, requestId: `${requestId}-${wake.kind}`, at: createdAt })).wake);
    else wakeRecords.push(...(await this.listOutbox()).filter((wake) => wake.workId === id));
    return { ...created, wakes: wakeRecords };
  }

  async #changeWork(scope, { workId, profile, actorId, expectedEpoch, requestId, payload, type, validate = () => true, update, at = this.#now() }) {
    const id = identifier(workId, "workId"); const request = identifier(requestId, "requestId"); const hash = commandHash(scope, { workId: id, actorId, expectedEpoch, profileId: profile?.profileId, ...payload });
    return transaction(this.#pool, async (client) => {
      const replay = await checkReplay(client, request, scope, hash); if (replay) return { replayed: true, work: publicWork(await readWork(client, id)) };
      const result = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id=$1 FOR UPDATE`, [id]); const row = result.rows[0];
      if (!row) throw new Error("WORK_NOT_FOUND"); if (!isControlProfile(profile) || row.control_profile_id !== profile.profileId) throw new Error("CONTROL_PROFILE_MISMATCH");
      if (actorId !== row.team_json.leaderMemberId) throw new Error("WORK_ACTOR_NOT_LEADER");
      if (row.status !== "open" || Number(row.epoch) !== expectedEpoch || !validate(row)) throw new Error("WORK_EPOCH_OR_CHANGE_CONFLICT");
      await ensureTimelineRoom(client, id, profile); const epoch = Number(row.epoch) + 1; const occurredAt = timestamp(at, "at"); await update(client, row, epoch, occurredAt);
      await appendTimeline(client, { workId: id, type, at: occurredAt, epoch, requestId: request, actorId, payload: { workId: id, ...payload } }); await saveReplay(client, request, scope, hash, { changed: true });
      return { replayed: false, work: publicWork(await readWork(client, id)) };
    });
  }
  async changeWorkTitle({ workId, title, profile, actorId, expectedEpoch, requestId } = {}) {
    const value = bounded(title, "title", 160); return this.#changeWork("work.title.change", { workId, profile, actorId, expectedEpoch, requestId, payload: { title: value }, type: "work-title-changed", update: async (client, row, epoch, at) => { const work = { ...row.work_json, title: value }; await client.query(`UPDATE ${SCHEMA}.work SET title=$2,work_json=$3::jsonb,epoch=$4,updated_at=$5 WHERE work_id=$1`, [workId, value, json(work), epoch, at]); } });
  }
  async changeWorkSpec({ workId, spec, profile, actorId, expectedEpoch, requestId } = {}) {
    if (!isWorkSpec(spec) || spec.workId !== workId) throw new Error("WorkSpec is invalid");
    return this.#changeWork("work.spec.change", { workId, profile, actorId, expectedEpoch, requestId, payload: { spec }, type: "work-spec-changed", at: spec.createdAt, validate: (row) => spec.revision === (row.current_work_spec?.revision ?? 0) + 1, update: async (client, _row, epoch, at) => client.query(`UPDATE ${SCHEMA}.work SET current_work_spec=$2::jsonb,epoch=$3,updated_at=$4 WHERE work_id=$1`, [workId, json(spec), epoch, at]) });
  }
  async changeWorkPlan({ workId, planRef, reason, profile, actorId, expectedEpoch, requestId } = {}) {
    const ref = createContentRef(planRef); const why = bounded(reason, "reason", 2048);
    return this.#changeWork("work.plan.change", { workId, profile, actorId, expectedEpoch, requestId, payload: { planRef: ref, reason: why }, type: "work-plan-changed", update: async (client, _row, epoch, at) => client.query(`UPDATE ${SCHEMA}.work SET current_plan_ref=$2::jsonb,epoch=$3,updated_at=$4 WHERE work_id=$1`, [workId, json(ref), epoch, at]) });
  }

  async createTask({ task, team, member, profile, actorId, expectedEpoch, requestId, wake } = {}) {
    if (!isTaskSpec(task) || !isTeamConfig(team) || !isMemberConfig(member) || !isControlProfile(profile) || actorId !== team.leaderMemberId) throw new Error("Task admission requires valid Leader bindings");
    if (task.assigneeMemberId !== member.memberId || member.teamId !== team.teamId || member.controlProfileId !== profile.profileId || !member.enabled) throw new Error("TASK_ASSIGNEE_BINDING_MISMATCH");
    const request = identifier(requestId, "requestId"); const hash = commandHash("task.create", { task, teamId: team.teamId, memberId: member.memberId, actorId, expectedEpoch, wake: wake ?? null });
    const result = await transaction(this.#pool, async (client) => {
      const replay = await checkReplay(client, request, "task.create", hash);
      if (replay) { const row = await client.query(`SELECT t.*,r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r USING(task_id) WHERE t.task_id=$1`, [task.taskId]); return { replayed: true, task: taskFrom(row.rows[0]), wake: null }; }
      const workResult = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id=$1 FOR UPDATE`, [task.workId]); const work = workResult.rows[0];
      if (!work || work.status !== "open" || !work.current_work_spec || Number(work.epoch) !== expectedEpoch || work.team_id !== team.teamId || work.control_profile_id !== profile.profileId) throw new Error("TASK_WORK_CONFLICT");
      const count = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.task WHERE work_id=$1`, [task.workId]); if (Number(count.rows[0].count) >= profile.maxTasksPerWork) throw new Error("TASK_WORK_CONFLICT");
      await ensureTimelineRoom(client, task.workId, profile); const epoch = Number(work.epoch) + 1; const at = timestamp(task.createdAt, "task.createdAt");
      await client.query(`INSERT INTO ${SCHEMA}.task(task_id,work_id,assignee_member_id,session_ref,spec_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$6)`, [task.taskId, task.workId, member.memberId, taskSessionFor(task, team.teamId), json(task), at]).catch((error) => { throw dbError(error, "TASK_ALREADY_EXISTS"); });
      await client.query(`UPDATE ${SCHEMA}.work SET epoch=$2,updated_at=$3 WHERE work_id=$1`, [task.workId, epoch, at]); await appendTimeline(client, { workId: task.workId, type: "task-created", at, epoch, requestId: request, actorId, payload: { task } }); await saveReplay(client, request, "task.create", hash, { created: true });
      return { replayed: false, task: { spec: clone(task), status: "assigned", result: null, cancellation: null }, wake: null };
    });
    if (!wake || result.replayed) return result;
    const enqueued = await this.enqueueWake({ workId: task.workId, taskId: task.taskId, targetMemberId: member.memberId, kind: wake.kind ?? "task-assignment", requestId: `${requestId}-wake`, at: task.createdAt }); return { ...result, wake: enqueued.wake };
  }

  async cancelTask({ workId, taskId, team, profile, actorId, reason, expectedEpoch, requestId } = {}) {
    if (!isTeamConfig(team) || actorId !== team.leaderMemberId) throw new Error("TASK_CANCEL_ACTOR_NOT_LEADER"); const why = bounded(reason, "reason", 2048); const request = identifier(requestId, "requestId"); const hash = commandHash("task.cancel", { workId, taskId, actorId, reason: why, expectedEpoch, profileId: profile?.profileId });
    return transaction(this.#pool, async (client) => {
      const replay = await checkReplay(client, request, "task.cancel", hash);
      const workResult = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id=$1 FOR UPDATE`, [workId]); const work = workResult.rows[0];
      const taskResult = await client.query(`SELECT t.*,r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r USING(task_id) WHERE t.task_id=$1 FOR UPDATE OF t`, [taskId]); const task = taskResult.rows[0];
      if (!work || !task || task.work_id !== workId) throw new Error("TASK_NOT_FOUND");
      if (replay) return { replayed: true, task: taskFrom(task) };
      if (!isControlProfile(profile) || work.control_profile_id !== profile.profileId || work.status !== "open" || Number(work.epoch) !== expectedEpoch || task.result_json || task.cancellation_json) throw new Error("TASK_CANCEL_CONFLICT");
      const guard = await this.#cancellationGuard.stopAndInspect({ workId, taskId }); if (guard?.stopped !== true || guard?.writerReleased !== true || !Array.isArray(guard?.unresolvedOperations) || guard.unresolvedOperations.length) throw new Error("TASK_CANCEL_GUARD_FAILED");
      await ensureTimelineRoom(client, workId, profile); const at = timestamp(this.#now(), "now"); const epoch = Number(work.epoch) + 1; const cancellation = { actorId, reason: why, at };
      await client.query(`UPDATE ${SCHEMA}.task SET cancellation_json=$2::jsonb,updated_at=$3 WHERE task_id=$1`, [taskId, json(cancellation), at]); await client.query(`UPDATE ${SCHEMA}.work SET epoch=$2,updated_at=$3 WHERE work_id=$1`, [workId, epoch, at]);
      await appendTimeline(client, { workId, type: "task-cancelled", at, epoch, requestId: request, actorId, payload: { workId, taskId, reason: why } }); await saveReplay(client, request, "task.cancel", hash, { cancelled: true }); return { replayed: false, task: taskFrom({ ...task, cancellation_json: cancellation }) };
    });
  }

  async submitResult({ result, team, member, profile, actorId, expectedEpoch, requestId, toolResultStore, contentRefResolver = this.#contentRefResolver } = {}) {
    if (!isResult(result) || !isTeamConfig(team) || !isMemberConfig(member) || !isControlProfile(profile) || result.submittedBy !== member.memberId || actorId !== member.memberId) throw new Error("Result submission requires valid producer bindings");
    if (result.deliverableRefs.length && (!contentRefResolver || typeof contentRefResolver.canRead !== "function")) throw new Error("CONTENT_REF_RESOLVER_UNAVAILABLE");
    for (const ref of result.deliverableRefs) if (!await contentRefResolver.canRead(ref)) throw new Error("CONTENT_REF_UNREADABLE");
    if (result.toolResultRefs.length && (!toolResultStore || typeof toolResultStore.get !== "function" || typeof toolResultStore.markRetention !== "function")) throw new Error("TOOL_RESULT_STORE_UNAVAILABLE");
    const retentionUntil = new Date(Date.parse(result.createdAt) + profile.toolResultRetentionMs).toISOString();
    for (const id of result.toolResultRefs) { const observed = await toolResultStore.get(id); if (!observed) throw new Error("TOOL_RESULT_NOT_FOUND"); if (observed.workId !== result.workId || observed.taskId !== result.taskId || observed.actorId !== actorId) throw new Error("TOOL_RESULT_OWNER_MISMATCH"); await toolResultStore.markRetention(id, { workId: result.workId, until: retentionUntil }); }
    const request = identifier(requestId, "requestId"); const hash = commandHash("task.result.submit", { result, teamId: team.teamId, memberId: member.memberId, actorId, expectedEpoch });
    return transaction(this.#pool, async (client) => {
      const replay = await checkReplay(client, request, "task.result.submit", hash); if (replay) return { replayed: true, result: await this.#readResult(client, result.taskId) };
      const workResult = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id=$1 FOR UPDATE`, [result.workId]); const work = workResult.rows[0]; const taskResult = await client.query(`SELECT t.*,r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r USING(task_id) WHERE t.task_id=$1 FOR UPDATE OF t`, [result.taskId]); const task = taskResult.rows[0];
      if (!work || !task || task.work_id !== result.workId || work.status !== "open" || Number(work.epoch) !== expectedEpoch || task.assignee_member_id !== member.memberId || task.result_json || task.cancellation_json) throw new Error("RESULT_TASK_CONFLICT");
      await ensureTimelineRoom(client, result.workId, profile); const at = timestamp(result.createdAt, "result.createdAt"); const epoch = Number(work.epoch) + 1;
      await client.query(`INSERT INTO ${SCHEMA}.result(task_id,work_id,result_json,created_at) VALUES($1,$2,$3::jsonb,$4)`, [result.taskId, result.workId, json(result), at]).catch((error) => { throw dbError(error, "RESULT_ALREADY_EXISTS"); });
      await client.query(`UPDATE ${SCHEMA}.task SET updated_at=$2 WHERE task_id=$1`, [result.taskId, at]); await client.query(`UPDATE ${SCHEMA}.work SET epoch=$2,updated_at=$3 WHERE work_id=$1`, [result.workId, epoch, at]); await appendTimeline(client, { workId: result.workId, type: "result-submitted", at, epoch, requestId: request, actorId, payload: { result } }); await saveReplay(client, request, "task.result.submit", hash, { submitted: true }); return { replayed: false, result: clone(result) };
    });
  }
  async #readResult(client, taskId) { const { rows } = await client.query(`SELECT result_json FROM ${SCHEMA}.result WHERE task_id=$1`, [taskId]); return rows[0]?.result_json ? clone(rows[0].result_json) : undefined; }

  async closeWork({ workId, team, profile, actorId, action, reason, expectedEpoch, requestId } = {}) {
    if (!isTeamConfig(team) || !isControlProfile(profile) || actorId !== team.leaderMemberId || !["complete", "stop"].includes(action)) throw new Error("WORK_CLOSE_INVALID");
    const why = bounded(reason, "reason", 4096); const request = identifier(requestId, "requestId"); const hash = commandHash("work.close", { workId, teamId: team.teamId, actorId, action, reason: why, expectedEpoch, profileId: profile.profileId });
    return transaction(this.#pool, async (client) => {
      const replay = await checkReplay(client, request, "work.close", hash); if (replay) return { replayed: true, action, work: publicWork(await readWork(client, workId)) };
      const result = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id=$1 FOR UPDATE`, [workId]); const work = result.rows[0];
      if (!work) throw new Error("WORK_NOT_FOUND"); if (work.team_id !== team.teamId || work.control_profile_id !== profile.profileId || work.status !== "open" || Number(work.epoch) !== expectedEpoch || (action === "complete" && !work.current_work_spec)) throw new Error("WORK_CLOSE_CONFLICT");
      const tasksResult = await client.query(`SELECT t.*,r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r USING(task_id) WHERE t.work_id=$1 ORDER BY t.task_id FOR UPDATE OF t`, [workId]); const tasks = tasksResult.rows.map(taskFrom);
      if (tasks.some((task) => !task.result && !task.cancellation)) throw new Error("WORK_CLOSE_GUARD_FAILED");
      const refs = tasks.flatMap((task) => task.result?.deliverableRefs ?? []); const guard = normalizeGuard(await this.#closeGuard.inspect({ work: publicWork(await readWork(client, workId)), tasks, resultRefs: clone(refs), action }));
      if (guard.activeExecutions.length || guard.unresolvedOperations.length || guard.pendingApprovals.length || guard.unreadableContentRefs.length) throw new Error("WORK_CLOSE_GUARD_FAILED");
      if (refs.length) { if (!this.#contentRefResolver || typeof this.#contentRefResolver.canRead !== "function") throw new Error("WORK_CLOSE_GUARD_FAILED"); for (const ref of refs) if (!await this.#contentRefResolver.canRead(ref)) throw new Error("WORK_CLOSE_GUARD_FAILED"); }
      await ensureTimelineRoom(client, workId, profile); const at = timestamp(this.#now(), "now"); const epoch = Number(work.epoch) + 1; const status = action === "complete" ? "completed" : "stopped";
      await client.query(`UPDATE ${SCHEMA}.work SET status=$2,epoch=$3,updated_at=$4 WHERE work_id=$1`, [workId, status, epoch, at]); await appendTimeline(client, { workId, type: action === "complete" ? "work-completed" : "work-stopped", at, epoch, requestId: request, actorId, payload: { reason: why } }); await saveReplay(client, request, "work.close", hash, { closed: true }); return { replayed: false, action, work: publicWork(await readWork(client, workId)) };
    });
  }

  async enqueueWake({ workId, taskId, targetMemberId, kind = "leader-resume", requestId, at = this.#now() } = {}) {
    if (!["task-assignment", "leader-resume", "result-notification", "human-reply"].includes(kind)) throw new Error("Unsupported wake kind"); const request = identifier(requestId, "requestId"); const wake = { wakeId: sha256({ kind, workId: workId ?? null, taskId: taskId ?? null, requestId: request }), ...(workId ? { workId: identifier(workId, "workId") } : {}), ...(taskId ? { taskId: identifier(taskId, "taskId") } : {}), kind, targetMemberId: identifier(targetMemberId, "targetMemberId"), status: "pending", createdAt: timestamp(at, "at") }; const hash = commandHash("wake.enqueue", wake);
    return transaction(this.#pool, async (client) => { const replay = await checkReplay(client, request, "wake.enqueue", hash); if (replay) return { replayed: true, wake: wakeFrom((await client.query(`SELECT * FROM ${SCHEMA}.wake WHERE wake_id=$1`, [wake.wakeId])).rows[0]) }; const count = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.wake WHERE status<>'acked'`); if (Number(count.rows[0].count) >= this.#maxOutboxEntries) throw new Error("OUTBOX_LIMIT_EXCEEDED"); await client.query(`INSERT INTO ${SCHEMA}.wake(wake_id,work_id,task_id,kind,target_member_id,status,created_at) VALUES($1,$2,$3,$4,$5,'pending',$6)`, [wake.wakeId, wake.workId ?? null, wake.taskId ?? null, kind, wake.targetMemberId, wake.createdAt]); await saveReplay(client, request, "wake.enqueue", hash, { enqueued: true }); return { replayed: false, wake }; });
  }
  async claimWake({ wakeId, consumerId, requestId, at = this.#now() } = {}) { return this.#wakeChange("wake.claim", { wakeId, consumerId, requestId, at }); }
  async ackWake({ wakeId, consumerId, receiptId, requestId, at = this.#now() } = {}) { return this.#wakeChange("wake.ack", { wakeId, consumerId, receiptId, requestId, at }); }
  async #wakeChange(scope, { wakeId, consumerId, receiptId, requestId, at }) {
    const id = digest(wakeId, "wakeId"); const consumer = identifier(consumerId, "consumerId"); const request = identifier(requestId, "requestId"); const receipt = receiptId === undefined ? undefined : bounded(receiptId, "receiptId", 256); const hash = commandHash(scope, { wakeId: id, consumerId: consumer, ...(receipt ? { receiptId: receipt } : {}) });
    return transaction(this.#pool, async (client) => { const replay = await checkReplay(client, request, scope, hash); const result = await client.query(`SELECT * FROM ${SCHEMA}.wake WHERE wake_id=$1 FOR UPDATE`, [id]); const row = result.rows[0]; if (!row) throw new Error("WAKE_NOT_FOUND"); if (replay) return { replayed: true, wake: wakeFrom(row) }; const when = timestamp(at, "at"); if (scope === "wake.claim") { if (row.status !== "pending") throw new Error("WAKE_CLAIM_CONFLICT"); await client.query(`UPDATE ${SCHEMA}.wake SET status='claimed',consumer_id=$2,claimed_at=$3 WHERE wake_id=$1`, [id, consumer, when]); } else { if (row.status !== "claimed" || row.consumer_id !== consumer) throw new Error("WAKE_ACK_CONFLICT"); await client.query(`UPDATE ${SCHEMA}.wake SET status='acked',receipt_id=$2,acked_at=$3 WHERE wake_id=$1`, [id, receipt, when]); } await saveReplay(client, request, scope, hash, { changed: true }); return { replayed: false, wake: wakeFrom((await client.query(`SELECT * FROM ${SCHEMA}.wake WHERE wake_id=$1`, [id])).rows[0]) }; });
  }

  async getWork(workId) { const client = await this.#pool.connect(); try { const entry = await readWork(client, identifier(workId, "workId")); return entry ? publicWork(entry) : undefined; } finally { client.release(); } }
  async listWorks({ teamId, roomId, status } = {}) { const client = await this.#pool.connect(); try { const params = []; const where = []; for (const [column, value] of [["team_id", teamId], ["room_id", roomId], ["status", status]]) if (value !== undefined) { params.push(value); where.push(`${column}=$${params.length}`); } const { rows } = await client.query(`SELECT work_id FROM ${SCHEMA}.work${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at,work_id`, params); const values = []; for (const row of rows) values.push(publicWork(await readWork(client, row.work_id))); return values; } finally { client.release(); } }
  async getTask(taskId) { const client = await this.#pool.connect(); try { const { rows } = await client.query(`SELECT t.*,r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r USING(task_id) WHERE t.task_id=$1`, [identifier(taskId, "taskId")]); return taskFrom(rows[0]); } finally { client.release(); } }
  async listTasks({ workId } = {}) { const client = await this.#pool.connect(); try { const { rows } = await client.query(`SELECT t.*,r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r USING(task_id)${workId ? " WHERE t.work_id=$1" : ""} ORDER BY t.created_at,t.task_id`, workId ? [identifier(workId, "workId")] : []); return rows.map(taskFrom); } finally { client.release(); } }
  async getResult(taskId) { const client = await this.#pool.connect(); try { return this.#readResult(client, identifier(taskId, "taskId")); } finally { client.release(); } }
  async listResults({ workId } = {}) { const client = await this.#pool.connect(); try { const { rows } = await client.query(`SELECT result_json FROM ${SCHEMA}.result${workId ? " WHERE work_id=$1" : ""} ORDER BY created_at,task_id`, workId ? [identifier(workId, "workId")] : []); return rows.map((row) => clone(row.result_json)); } finally { client.release(); } }
  async getMessageBinding(roomId, eventId) { const client = await this.#pool.connect(); try { const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_binding WHERE room_id=$1 AND event_id=$2`, [roomId, eventId]); return bindingFrom(rows[0]); } finally { client.release(); } }
  async listMessageAdmissions({ roomId, status } = {}) { if (status !== undefined && !["pending", "routed"].includes(status)) throw new Error("MESSAGE_ADMISSION_STATUS_INVALID"); const client = await this.#pool.connect(); try { const params = []; const where = []; if (roomId !== undefined) { params.push(roomId); where.push(`room_id=$${params.length}`); } if (status !== undefined) { params.push(status); where.push(`status=$${params.length}`); } const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.matrix_message_admission${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at,event_id`, params); return rows.map(admissionFrom); } finally { client.release(); } }
  async admissionMetrics({ roomId } = {}) { const pending = await this.listMessageAdmissions({ roomId, status: "pending" }); return { pendingCount: pending.length, oldestReceivedAt: pending[0]?.receivedAt ?? null, lastErrorCode: [...pending].reverse().find((entry) => entry.lastErrorCode)?.lastErrorCode ?? null }; }
  async getWake(wakeId) { const client = await this.#pool.connect(); try { const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.wake WHERE wake_id=$1`, [digest(wakeId, "wakeId")]); return rows[0] ? wakeFrom(rows[0]) : undefined; } finally { client.release(); } }
  async listOutbox({ status } = {}) { if (status !== undefined && !["pending", "claimed", "acked"].includes(status)) throw new Error("Unsupported outbox status"); const client = await this.#pool.connect(); try { const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.wake${status ? " WHERE status=$1" : ""} ORDER BY created_at,wake_id`, status ? [status] : []); return rows.map(wakeFrom); } finally { client.release(); } }
  async health() { const client = await this.#pool.connect(); try { const { rows } = await client.query(`SELECT (SELECT count(*) FROM ${SCHEMA}.work)::int AS work_count,(SELECT count(*) FROM ${SCHEMA}.task)::int AS task_count,(SELECT count(*) FROM ${SCHEMA}.matrix_message_admission WHERE status='pending')::int AS pending_admission_count,(SELECT count(*) FROM ${SCHEMA}.wake)::int AS outbox_count`); return { backend: "postgres", workCount: Number(rows[0].work_count), taskCount: Number(rows[0].task_count), pendingAdmissionCount: Number(rows[0].pending_admission_count), outboxCount: Number(rows[0].outbox_count) }; } finally { client.release(); } }
}
