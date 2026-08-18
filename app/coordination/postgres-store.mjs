import { readFile } from "node:fs/promises";

import {
  createCoordinationDecision,
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
const MAX_TIMELINE_ENTRIES = 4096;
const MAX_OUTBOX_ENTRIES = 1024;

function clone(value) {
  return structuredClone(value);
}

function bounded(value, name, limit = 4096) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit || /[\u0000\r\n]/u.test(value)) {
    throw new TypeError(`${name} is missing or exceeds the bounded limit`);
  }
  return value;
}

function identifier(value, name) {
  const normalized = bounded(value, name, 160);
  if (!ID.test(normalized)) throw new TypeError(`${name} has an invalid identifier`);
  return normalized;
}

function digest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${name} must be a SHA-256 digest`);
  return value;
}

function timestamp(value, name) {
  const normalized = bounded(value, name, 64);
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${name} must be an ISO timestamp`);
  return new Date(normalized).toISOString();
}

function workRecord({ workId, teamId, routeId, actorId, sourceEventId, controlProfileId, leaderSessionId, createdAt }) {
  const base = {
    kind: "tiangong.work",
    schemaVersion: 1,
    workId: identifier(workId, "workId"),
    teamId: identifier(teamId, "teamId"),
    routeId: identifier(routeId, "routeId"),
    actorId: bounded(actorId, "actorId", 256),
    sourceEventId: bounded(sourceEventId, "sourceEventId", 256),
    controlProfileId: identifier(controlProfileId, "controlProfileId"),
    leaderSessionId: identifier(leaderSessionId, "leaderSessionId"),
    createdAt: timestamp(createdAt, "createdAt"),
  };
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}

function sessionFor(workId, teamId, routeId) {
  return `leader-${sha256({ workId, teamId, routeId }).slice(0, 48)}`;
}

function commandHash(scope, payload) {
  return sha256({ scope, payload });
}

function rowJson(value) {
  return value ?? null;
}

function iso(value) {
  return new Date(value).toISOString();
}

function dbError(error, fallback) {
  if (error?.code === "23505") return new Error(fallback);
  return error;
}

async function withTransaction(pool, callback) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("PostgresCoordinationStore requires a pg-compatible pool");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await callback(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

function timelineEntry(row) {
  const payload = row.payload ?? {};
  const at = iso(row.occurred_at);
  return {
    sequence: row.sequence,
    eventHash: sha256({ workId: row.work_id, sequence: row.sequence, type: row.type, at, epoch: row.epoch, requestId: row.request_id ?? null, payload }),
    type: row.type,
    at,
    actorId: payload.actorId ?? null,
    requestId: row.request_id ?? null,
    epoch: row.epoch,
    payload: clone(payload),
  };
}

function wakeFromRow(row) {
  return {
    wakeId: row.wake_id,
    ...(row.work_id ? { workId: row.work_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    kind: row.kind,
    targetMemberId: row.target_member_id,
    status: row.status,
    ...(row.consumer_id ? { consumerId: row.consumer_id } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    createdAt: iso(row.created_at),
    ...(row.claimed_at ? { claimedAt: iso(row.claimed_at) } : {}),
    ...(row.acked_at ? { ackedAt: iso(row.acked_at) } : {}),
  };
}

async function readTimeline(client, workId) {
  const { rows } = await client.query(
    `SELECT work_id, sequence, type, occurred_at, epoch, request_id, payload
       FROM ${SCHEMA}.work_timeline
      WHERE work_id = $1
      ORDER BY sequence ASC`,
    [workId],
  );
  return rows.map(timelineEntry);
}

async function readWork(client, workId) {
  const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id = $1`, [workId]);
  if (rows.length === 0) return undefined;
  const row = rows[0];
  return {
    work: clone(row.work_json),
    team: clone(row.team_json),
    route: clone(row.route_json),
    profile: clone(row.profile_json),
    epoch: row.epoch,
    status: row.status,
    currentWorkSpec: clone(row.current_work_spec),
    closeDecision: row.close_decision_json ? clone(row.close_decision_json) : null,
    timeline: await readTimeline(client, workId),
  };
}

function publicWork(entry) {
  return clone({
    work: entry.work,
    epoch: entry.epoch,
    status: entry.status,
    currentWorkSpec: entry.currentWorkSpec,
    closeDecision: entry.closeDecision ?? null,
    timeline: entry.timeline,
  });
}

function taskFromRow(row) {
  if (!row) return undefined;
  return {
    spec: clone(row.spec_json),
    status: row.status,
    result: row.result_json ? clone(row.result_json) : null,
    cancellation: row.cancellation_json ? clone(row.cancellation_json) : null,
    decision: row.decision_json ? clone(row.decision_json) : null,
  };
}

function resultFromRow(row) {
  return row?.result_json ? clone(row.result_json) : undefined;
}

async function readReplay(client, requestId) {
  const { rows } = await client.query(
    `SELECT request_hash, response_json
       FROM ${SCHEMA}.request_replay
      WHERE request_id = $1
      FOR UPDATE`,
    [requestId],
  );
  return rows[0] ?? null;
}

export class PostgresCoordinationStore {
  #pool;
  #now;
  #maxTimelineEntries;
  #maxOutboxEntries;

  constructor({ pool, now = () => new Date().toISOString(), maxTimelineEntries = MAX_TIMELINE_ENTRIES, maxOutboxEntries = MAX_OUTBOX_ENTRIES } = {}) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("PostgresCoordinationStore pool is required");
    if (typeof now !== "function") throw new TypeError("PostgresCoordinationStore now must be a function");
    if (!Number.isSafeInteger(maxTimelineEntries) || maxTimelineEntries < 1 || maxTimelineEntries > MAX_TIMELINE_ENTRIES) throw new TypeError("maxTimelineEntries is outside the bounded range");
    if (!Number.isSafeInteger(maxOutboxEntries) || maxOutboxEntries < 1 || maxOutboxEntries > MAX_OUTBOX_ENTRIES) throw new TypeError("maxOutboxEntries is outside the bounded range");
    this.#pool = pool;
    this.#now = now;
    this.#maxTimelineEntries = maxTimelineEntries;
    this.#maxOutboxEntries = maxOutboxEntries;
  }

  async migrate({ sql } = {}) {
    const migrationSql = sql ?? await readFile(new URL("./migrations/001_coordination.sql", import.meta.url), "utf8");
    const taskResultSql = sql ? "" : await readFile(new URL("./migrations/002_task_result.sql", import.meta.url), "utf8");
    const decisionSql = sql ? "" : await readFile(new URL("./migrations/003_decision_closure.sql", import.meta.url), "utf8");
    return withTransaction(this.#pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('tiangong_coordination.migrations'))");
      await client.query(migrationSql);
      if (taskResultSql) await client.query(taskResultSql);
      if (decisionSql) await client.query(decisionSql);
      return { version: decisionSql ? "003_decision_closure" : taskResultSql ? "002_task_result" : "001_coordination" };
    });
  }

  async createWork({ workId, team, route, profile, spec, actorId, sourceEventId, requestId, leaderSessionId, wakes = [] } = {}) {
    const currentProfile = isControlProfile(profile) ? profile : (() => { throw new Error("Work admission requires a valid ControlProfile"); })();
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isWorkSpec(spec)) throw new Error("Work admission requires valid TeamConfig, route binding, and WorkSpec");
    const normalizedWorkId = identifier(workId, "workId");
    const normalizedRequestId = identifier(requestId, "requestId");
    if (team.controlProfileId !== currentProfile.profileId || route.teamId !== team.teamId || spec.workId !== normalizedWorkId) throw new Error("WORK_ADMISSION_BINDING_MISMATCH");
    const sessionId = leaderSessionId ?? sessionFor(normalizedWorkId, team.teamId, route.routeId);
    const work = workRecord({ workId: normalizedWorkId, teamId: team.teamId, routeId: route.routeId, actorId, sourceEventId, controlProfileId: currentProfile.profileId, leaderSessionId: sessionId, createdAt: spec.createdAt });
    if (!Array.isArray(wakes) || wakes.length > 2) throw new TypeError("Work wakes must contain at most two entries");
    const wakeRecords = wakes.map((wake) => {
      if (!wake || !["leader-resume", "human-reply"].includes(wake.kind)) throw new Error("Unsupported Work wake kind");
      return {
        wakeId: sha256({ kind: wake.kind, workId: normalizedWorkId, targetMemberId: wake.targetMemberId, requestId: normalizedRequestId }),
        kind: wake.kind,
        workId: normalizedWorkId,
        targetMemberId: identifier(wake.targetMemberId, "wake.targetMemberId"),
        status: "pending",
        createdAt: timestamp(spec.createdAt, "spec.createdAt"),
      };
    });
    const payload = { work, team, route, profile: currentProfile, spec, wakes: wakeRecords };
    const requestHash = commandHash("work.create", payload);
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, normalizedRequestId);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const result = clone(replay.response_json);
        result.replayed = true;
        return result;
      }
      const existing = await readWork(client, normalizedWorkId);
      if (existing) throw new Error("WORK_ALREADY_EXISTS");
      const binding = await client.query(
        `SELECT work_id FROM ${SCHEMA}.matrix_message_binding WHERE room_id = $1 AND event_id = $2 FOR UPDATE`,
        [route.roomId, sourceEventId],
      );
      if (binding.rows[0] && binding.rows[0].work_id !== normalizedWorkId) throw new Error("MATRIX_MESSAGE_ALREADY_BOUND");
      const now = timestamp(this.#now(), "now");
      await client.query(
        `INSERT INTO ${SCHEMA}.work
          (work_id, team_id, route_id, room_id, actor_id, source_event_id, control_profile_id, leader_session_id,
           work_json, team_json, route_json, profile_json, current_work_spec, status, epoch, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,'open',0,$14,$14)`,
        [normalizedWorkId, team.teamId, route.routeId, route.roomId, work.actorId, work.sourceEventId, currentProfile.profileId, sessionId,
          rowJson(work), rowJson(team), rowJson(route), rowJson(currentProfile), rowJson(spec), now],
      ).catch((error) => { throw dbError(error, "WORK_ALREADY_EXISTS"); });
      const timelinePayload = { work, team, route, profile: currentProfile, spec, actorId: work.actorId };
      await client.query(
        `INSERT INTO ${SCHEMA}.work_timeline (work_id, sequence, type, occurred_at, epoch, request_id, payload)
         VALUES ($1,1,'work-created',$2,0,$3,$4::jsonb)`,
        [normalizedWorkId, timestamp(spec.createdAt, "spec.createdAt"), normalizedRequestId, rowJson(timelinePayload)],
      );
      await client.query(
        `INSERT INTO ${SCHEMA}.matrix_message_binding (room_id, event_id, work_id, actor_id, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [route.roomId, sourceEventId, normalizedWorkId, work.actorId, now],
      ).catch((error) => { throw dbError(error, "MATRIX_MESSAGE_ALREADY_BOUND"); });
      for (const wake of wakeRecords) {
        await client.query(
          `INSERT INTO ${SCHEMA}.wake
            (wake_id, work_id, task_id, kind, target_member_id, status, created_at)
           VALUES ($1,$2,NULL,$3,$4,'pending',$5)`,
          [wake.wakeId, normalizedWorkId, wake.kind, wake.targetMemberId, wake.createdAt],
        ).catch((error) => { throw dbError(error, "WAKE_ALREADY_EXISTS"); });
      }
      const response = {
        replayed: false,
        work: publicWork({ work, epoch: 0, status: "open", currentWorkSpec: spec, timeline: [timelineEntry({
          work_id: normalizedWorkId,
          sequence: 1,
          type: "work-created",
          occurred_at: spec.createdAt,
          epoch: 0,
          request_id: normalizedRequestId,
          payload: timelinePayload,
        })] }),
        wakes: wakeRecords,
      };
      await client.query(
        `INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json)
         VALUES ($1,'work.create',$2,$3::jsonb)`,
        [normalizedRequestId, requestHash, rowJson(response)],
      );
      return response;
    });
  }

  async changeWorkSpec({ workId, spec, profile, actorId, expectedEpoch, requestId } = {}) {
    if (!isControlProfile(profile) || !isWorkSpec(spec)) throw new Error("WorkSpec or ControlProfile is invalid");
    const id = identifier(workId, "workId");
    const request = identifier(requestId, "requestId");
    const requestHash = commandHash("work.spec.change", { workId: id, spec, actorId, expectedEpoch, profileId: profile.profileId });
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, request);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const result = clone(replay.response_json);
        result.replayed = true;
        return result;
      }
      const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id = $1 FOR UPDATE`, [id]);
      if (rows.length === 0) throw new Error("WORK_NOT_FOUND");
      const row = rows[0];
      if (row.control_profile_id !== profile.profileId) throw new Error("CONTROL_PROFILE_MISMATCH");
      const current = row.current_work_spec;
      if (row.status !== "open" || spec.workId !== id || spec.revision !== current.revision + 1 || expectedEpoch !== row.epoch) throw new Error("WORK_EPOCH_OR_SPEC_CONFLICT");
      const timelineCount = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.work_timeline WHERE work_id = $1`, [id]);
      if (Number(timelineCount.rows[0].count) >= Math.min(profile.maxTimelineEntries, this.#maxTimelineEntries)) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED");
      const at = timestamp(spec.createdAt, "spec.createdAt");
      const payload = { workId: id, spec, actorId: bounded(actorId, "actorId", 256), expectedEpoch };
      const nextEpoch = row.epoch + 1;
      const nextSequence = await this.#nextSequence(client, id);
      await client.query(
        `UPDATE ${SCHEMA}.work SET current_work_spec = $2::jsonb, epoch = $3, updated_at = $4 WHERE work_id = $1`,
        [id, rowJson(spec), nextEpoch, at],
      );
      await client.query(
        `INSERT INTO ${SCHEMA}.work_timeline (work_id, sequence, type, occurred_at, epoch, request_id, payload)
         VALUES ($1,$2,'work-spec-changed',$3,$4,$5,$6::jsonb)`,
        [id, nextSequence, at, nextEpoch, request, rowJson(payload)],
      );
      const entry = await readWork(client, id);
      const response = { replayed: false, work: publicWork(entry) };
      await client.query(
        `INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json)
         VALUES ($1,'work.spec.change',$2,$3::jsonb)`,
        [request, requestHash, rowJson(response)],
      );
      return response;
    });
  }

  async #nextSequence(client, workId) {
    const { rows } = await client.query(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM ${SCHEMA}.work_timeline WHERE work_id = $1`, [workId]);
    return Number(rows[0].next_sequence);
  }

  async createTask({ task, team, member, profile, actorId, expectedEpoch, requestId, wake } = {}) {
    if (!isTaskSpec(task) || !isTeamConfig(team) || !isMemberConfig(member) || !isControlProfile(profile)) {
      throw new Error("Task admission requires valid TaskSpec, TeamConfig, MemberConfig, and ControlProfile");
    }
    if (task.assigneeMemberId !== member.memberId || member.teamId !== team.teamId ||
        member.controlProfileId !== profile.profileId || !member.enabled) {
      throw new Error("TASK_ASSIGNEE_BINDING_MISMATCH");
    }
    const id = identifier(task.taskId, "taskId");
    const workId = identifier(task.workId, "workId");
    const request = identifier(requestId, "requestId");
    const wakeRecord = wake ? {
      wakeId: sha256({ kind: wake.kind ?? "task-assignment", taskId: id, requestId: request }),
      kind: wake.kind ?? "task-assignment",
      workId,
      taskId: id,
      targetMemberId: identifier(wake.targetMemberId ?? member.memberId, "wake.targetMemberId"),
      status: "pending",
      createdAt: timestamp(task.createdAt, "task.createdAt"),
    } : null;
    if (wakeRecord && !["task-assignment", "result-notification"].includes(wakeRecord.kind)) throw new Error("Unsupported task wake kind");
    const requestHash = commandHash("task.create", { task, teamId: team.teamId, member, actorId, expectedEpoch, profileId: profile.profileId, wake: wakeRecord });
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, request);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const currentTask = await client.query(`SELECT t.*, r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r ON r.task_id = t.task_id WHERE t.task_id = $1`, [id]);
        const currentWake = wakeRecord ? await client.query(`SELECT * FROM ${SCHEMA}.wake WHERE wake_id = $1`, [wakeRecord.wakeId]) : { rows: [] };
        const result = clone(replay.response_json);
        result.replayed = true;
        result.task = taskFromRow(currentTask.rows[0]);
        result.wake = wakeRecord ? wakeFromRow(currentWake.rows[0]) : null;
        return result;
      }
      const { rows: workRows } = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id = $1 FOR UPDATE`, [workId]);
      if (workRows.length === 0) throw new Error("WORK_NOT_FOUND");
      const work = workRows[0];
      if (work.team_id !== team.teamId || work.control_profile_id !== profile.profileId || work.status !== "open" ||
          expectedEpoch !== work.epoch) throw new Error("TASK_WORK_CONFLICT");
      const timelineCount = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.work_timeline WHERE work_id = $1`, [workId]);
      if (Number(timelineCount.rows[0].count) >= Math.min(profile.maxTimelineEntries, this.#maxTimelineEntries)) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED");
      const count = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.task WHERE work_id = $1`, [workId]);
      if (Number(count.rows[0].count) >= profile.maxTasksPerWork) throw new Error("TASK_WORK_CONFLICT");
      const existing = await client.query(`SELECT task_id FROM ${SCHEMA}.task WHERE task_id = $1`, [id]);
      if (existing.rows.length > 0) throw new Error("TASK_ALREADY_EXISTS");
      const at = timestamp(task.createdAt, "task.createdAt");
      const nextEpoch = work.epoch + 1;
      const sequence = await this.#nextSequence(client, workId);
      await client.query(
        `INSERT INTO ${SCHEMA}.task (task_id, work_id, assignee_member_id, spec_json, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,'assigned',$5,$5)`,
        [id, workId, member.memberId, rowJson(task), at],
      ).catch((error) => { throw dbError(error, "TASK_ALREADY_EXISTS"); });
      await client.query(`UPDATE ${SCHEMA}.work SET epoch = $2, updated_at = $3 WHERE work_id = $1`, [workId, nextEpoch, at]);
      const payload = { task, actorId: bounded(actorId, "actorId", 256), expectedEpoch };
      await client.query(
        `INSERT INTO ${SCHEMA}.work_timeline (work_id, sequence, type, occurred_at, epoch, request_id, payload)
         VALUES ($1,$2,'task-created',$3,$4,$5,$6::jsonb)`,
        [workId, sequence, at, nextEpoch, request, rowJson(payload)],
      );
      if (wakeRecord) {
        await client.query(
          `INSERT INTO ${SCHEMA}.wake (wake_id, work_id, task_id, kind, target_member_id, status, created_at)
           VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
          [wakeRecord.wakeId, workId, id, wakeRecord.kind, wakeRecord.targetMemberId, wakeRecord.createdAt],
        ).catch((error) => { throw dbError(error, "WAKE_ALREADY_EXISTS"); });
      }
      const inserted = await client.query(`SELECT * FROM ${SCHEMA}.task WHERE task_id = $1`, [id]);
      const response = { replayed: false, task: taskFromRow(inserted.rows[0]), wake: wakeRecord };
      await client.query(
        `INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json)
         VALUES ($1,'task.create',$2,$3::jsonb)`,
        [request, requestHash, rowJson(response)],
      );
      return response;
    });
  }

  async cancelTask({ workId, taskId, profile, actorId, reason, expectedEpoch, requestId } = {}) {
    if (!isControlProfile(profile)) throw new Error("A schema-valid current ControlProfile is required");
    const id = identifier(taskId, "taskId");
    const work = identifier(workId, "workId");
    const request = identifier(requestId, "requestId");
    const normalizedReason = bounded(reason, "reason", 2048);
    const requestHash = commandHash("task.cancel", { workId: work, taskId: id, actorId, reason: normalizedReason, expectedEpoch, profileId: profile.profileId });
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, request);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const result = clone(replay.response_json); result.replayed = true; return result;
      }
      const { rows: workRows } = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id = $1 FOR UPDATE`, [work]);
      const { rows: taskRows } = await client.query(`SELECT * FROM ${SCHEMA}.task WHERE task_id = $1 FOR UPDATE`, [id]);
      if (workRows.length === 0 || taskRows.length === 0 || taskRows[0].work_id !== work) throw new Error("TASK_NOT_FOUND");
      const workRow = workRows[0];
      const taskRow = taskRows[0];
      if (workRow.control_profile_id !== profile.profileId || workRow.status !== "open" || expectedEpoch !== workRow.epoch ||
          taskRow.status === "cancelled" || taskRow.result_id) throw new Error("TASK_CANCEL_CONFLICT");
      const timelineCount = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.work_timeline WHERE work_id = $1`, [work]);
      if (Number(timelineCount.rows[0].count) >= Math.min(profile.maxTimelineEntries, this.#maxTimelineEntries)) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED");
      const at = timestamp(this.#now(), "now");
      const nextEpoch = workRow.epoch + 1;
      const sequence = await this.#nextSequence(client, work);
      const cancellation = { actorId: bounded(actorId, "actorId", 256), reason: normalizedReason, at };
      await client.query(`UPDATE ${SCHEMA}.task SET status='cancelled', cancellation_json=$2::jsonb, updated_at=$3 WHERE task_id=$1`, [id, rowJson(cancellation), at]);
      await client.query(`UPDATE ${SCHEMA}.work SET epoch=$2, updated_at=$3 WHERE work_id=$1`, [work, nextEpoch, at]);
      const payload = { workId: work, taskId: id, actorId: cancellation.actorId, reason: normalizedReason, expectedEpoch };
      await client.query(
        `INSERT INTO ${SCHEMA}.work_timeline (work_id, sequence, type, occurred_at, epoch, request_id, payload)
         VALUES ($1,$2,'task-cancelled',$3,$4,$5,$6::jsonb)`,
        [work, sequence, at, nextEpoch, request, rowJson(payload)],
      );
      const response = { replayed: false, task: taskFromRow({ ...taskRow, status: "cancelled", cancellation_json: cancellation }) };
      await client.query(`INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json) VALUES ($1,'task.cancel',$2,$3::jsonb)`, [request, requestHash, rowJson(response)]);
      return response;
    });
  }

  async submitResult({ result, team, member, profile, actorId, expectedEpoch, requestId, toolResultStore } = {}) {
    if (!isResult(result) || !isTeamConfig(team) || !isMemberConfig(member) || !isControlProfile(profile)) {
      throw new Error("Result submission requires valid Result, TeamConfig, MemberConfig, and ControlProfile");
    }
    if (result.producerMemberId !== member.memberId || member.teamId !== team.teamId || member.controlProfileId !== profile.profileId || !member.enabled) {
      throw new Error("RESULT_PRODUCER_BINDING_MISMATCH");
    }
    if (!toolResultStore || typeof toolResultStore.get !== "function" || typeof toolResultStore.markRetention !== "function") {
      if (result.toolResultIds.length > 0) throw new TypeError("ToolResult store is required for cited ToolResults");
    }
    const retentionUntil = new Date(Date.parse(result.createdAt) + profile.toolResultRetentionMs).toISOString();
    for (const toolResultId of result.toolResultIds) {
      const observed = await toolResultStore.get(toolResultId);
      if (!observed) throw new Error("TOOL_RESULT_NOT_FOUND");
      if (observed.workId !== result.workId || observed.taskId !== result.taskId) throw new Error("TOOL_RESULT_OWNER_MISMATCH");
      await toolResultStore.markRetention(toolResultId, { workId: result.workId, until: retentionUntil });
    }
    const workId = identifier(result.workId, "workId");
    const taskId = identifier(result.taskId, "taskId");
    const request = identifier(requestId, "requestId");
    const requestHash = commandHash("task.result.submit", { result, teamId: team.teamId, member, actorId, expectedEpoch, profileId: profile.profileId });
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, request);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const value = clone(replay.response_json); value.replayed = true; return value;
      }
      const { rows: workRows } = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id = $1 FOR UPDATE`, [workId]);
      const { rows: taskRows } = await client.query(`SELECT * FROM ${SCHEMA}.task WHERE task_id = $1 FOR UPDATE`, [taskId]);
      if (workRows.length === 0 || taskRows.length === 0 || taskRows[0].work_id !== workId) throw new Error("TASK_NOT_FOUND");
      const workRow = workRows[0];
      const taskRow = taskRows[0];
      if (workRow.team_id !== team.teamId || workRow.control_profile_id !== profile.profileId || workRow.status !== "open" ||
          taskRow.assignee_member_id !== member.memberId || taskRow.status === "cancelled" || taskRow.result_id || expectedEpoch !== workRow.epoch) {
        throw new Error("RESULT_TASK_CONFLICT");
      }
      const timelineCount = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.work_timeline WHERE work_id = $1`, [workId]);
      if (Number(timelineCount.rows[0].count) >= Math.min(profile.maxTimelineEntries, this.#maxTimelineEntries)) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED");
      const existing = await client.query(`SELECT result_json FROM ${SCHEMA}.result WHERE result_id = $1`, [result.resultId]);
      if (existing.rows.length > 0) throw new Error("RESULT_ALREADY_EXISTS");
      const at = timestamp(result.createdAt, "result.createdAt");
      const nextEpoch = workRow.epoch + 1;
      const sequence = await this.#nextSequence(client, workId);
      await client.query(`INSERT INTO ${SCHEMA}.result (result_id, work_id, task_id, result_json, created_at) VALUES ($1,$2,$3,$4::jsonb,$5)`, [result.resultId, workId, taskId, rowJson(result), at]).catch((error) => { throw dbError(error, "RESULT_ALREADY_EXISTS"); });
      await client.query(`UPDATE ${SCHEMA}.task SET status='reported', result_id=$2, updated_at=$3 WHERE task_id=$1`, [taskId, result.resultId, at]);
      await client.query(`UPDATE ${SCHEMA}.work SET epoch=$2, updated_at=$3 WHERE work_id=$1`, [workId, nextEpoch, at]);
      const payload = { result, actorId: bounded(actorId, "actorId", 256), expectedEpoch };
      await client.query(`INSERT INTO ${SCHEMA}.work_timeline (work_id, sequence, type, occurred_at, epoch, request_id, payload) VALUES ($1,$2,'result-submitted',$3,$4,$5,$6::jsonb)`, [workId, sequence, at, nextEpoch, request, rowJson(payload)]);
      const response = { replayed: false, result };
      await client.query(`INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json) VALUES ($1,'task.result.submit',$2,$3::jsonb)`, [request, requestHash, rowJson(response)]);
      return response;
    });
  }

  async decideTask({ taskId, team, profile, actorId, decision, resultDigest, reason, expectedEpoch, requestId } = {}) {
    if (!isTeamConfig(team) || !isControlProfile(profile)) throw new Error("Task decision requires valid TeamConfig and ControlProfile");
    if (actorId !== team.leaderMemberId) throw new Error("TASK_DECISION_ACTOR_NOT_LEADER");
    const id = identifier(taskId, "taskId");
    const action = bounded(decision, "decision", 32);
    if (!["accept", "blocked"].includes(action)) throw new Error("TASK_DECISION_INVALID");
    const normalizedReason = bounded(reason, "reason", 4096);
    const normalizedResultDigest = resultDigest === undefined ? undefined : digest(resultDigest, "resultDigest");
    const request = identifier(requestId, "requestId");
    const requestHash = commandHash("task.decide", { taskId: id, teamId: team.teamId, actorId, decision: action, resultDigest: normalizedResultDigest ?? null, reason: normalizedReason, expectedEpoch, profileId: profile.profileId });
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, request);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const response = clone(replay.response_json); response.replayed = true; return response;
      }
      const taskResult = await client.query(`SELECT * FROM ${SCHEMA}.task WHERE task_id = $1 FOR UPDATE`, [id]);
      if (taskResult.rows.length === 0) throw new Error("TASK_NOT_FOUND");
      const resultRow = await client.query(`SELECT result_json FROM ${SCHEMA}.result WHERE task_id = $1`, [id]);
      const taskRow = { ...taskResult.rows[0], result_json: resultRow.rows[0]?.result_json ?? null };
      const workResult = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id = $1 FOR UPDATE`, [taskRow.work_id]);
      if (workResult.rows.length === 0) throw new Error("WORK_NOT_FOUND");
      const work = workResult.rows[0];
      if (work.team_id !== team.teamId || work.control_profile_id !== profile.profileId) throw new Error("TASK_TEAM_BINDING_MISMATCH");
      if (work.status !== "open" || taskRow.decision_json || expectedEpoch !== work.epoch) throw new Error("TASK_DECISION_CONFLICT");
      if (action === "accept" && (!taskRow.result_json || taskRow.status !== "reported" || normalizedResultDigest !== taskRow.result_json.contentDigest)) throw new Error("TASK_DECISION_RESULT_CONFLICT");
      if (action === "blocked" && !["assigned", "reported"].includes(taskRow.status)) throw new Error("TASK_DECISION_CONFLICT");
      const decisionRecord = createCoordinationDecision({
        decisionId: sha256({ scope: "task", taskId: id, requestId: request, decision: action, resultDigest: normalizedResultDigest ?? null }),
        workId: taskRow.work_id,
        taskId: id,
        decision: action,
        ...(normalizedResultDigest !== undefined ? { resultDigest: normalizedResultDigest } : {}),
        reason: normalizedReason,
        createdAt: this.#now(),
      });
      const timelineCount = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.work_timeline WHERE work_id = $1`, [taskRow.work_id]);
      if (Number(timelineCount.rows[0].count) >= Math.min(profile.maxTimelineEntries, this.#maxTimelineEntries)) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED");
      const nextEpoch = work.epoch + 1;
      const sequence = await this.#nextSequence(client, taskRow.work_id);
      const status = action === "accept" ? "accepted" : "blocked";
      await client.query(`UPDATE ${SCHEMA}.task SET status=$2, decision_json=$3::jsonb, updated_at=$4 WHERE task_id=$1`, [id, status, rowJson(decisionRecord), decisionRecord.createdAt]);
      await client.query(`UPDATE ${SCHEMA}.work SET epoch=$2, updated_at=$3 WHERE work_id=$1`, [taskRow.work_id, nextEpoch, decisionRecord.createdAt]);
      const payload = { workId: taskRow.work_id, taskId: id, actorId: bounded(actorId, "actorId", 256), expectedEpoch, decision: decisionRecord };
      await client.query(`INSERT INTO ${SCHEMA}.work_timeline (work_id, sequence, type, occurred_at, epoch, request_id, payload) VALUES ($1,$2,'task-decided',$3,$4,$5,$6::jsonb)`, [taskRow.work_id, sequence, decisionRecord.createdAt, nextEpoch, request, rowJson(payload)]);
      const response = { replayed: false, decision: decisionRecord, task: taskFromRow({ ...taskRow, status, decision_json: decisionRecord }), work: publicWork(await readWork(client, taskRow.work_id)) };
      await client.query(`INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json) VALUES ($1,'task.decide',$2,$3::jsonb)`, [request, requestHash, rowJson(response)]);
      return response;
    });
  }

  async closeWork({ workId, team, profile, actorId, decision, reason, expectedEpoch, requestId } = {}) {
    if (!isTeamConfig(team) || !isControlProfile(profile)) throw new Error("Work closure requires valid TeamConfig and ControlProfile");
    if (actorId !== team.leaderMemberId) throw new Error("WORK_CLOSE_ACTOR_NOT_LEADER");
    const id = identifier(workId, "workId");
    const action = bounded(decision, "decision", 32);
    if (!["complete", "stop"].includes(action)) throw new Error("WORK_CLOSE_INVALID");
    const normalizedReason = bounded(reason, "reason", 4096);
    const request = identifier(requestId, "requestId");
    const requestHash = commandHash("work.close", { workId: id, teamId: team.teamId, actorId, decision: action, reason: normalizedReason, expectedEpoch, profileId: profile.profileId });
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, request);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const response = clone(replay.response_json); response.replayed = true; return response;
      }
      const workResult = await client.query(`SELECT * FROM ${SCHEMA}.work WHERE work_id = $1 FOR UPDATE`, [id]);
      if (workResult.rows.length === 0) throw new Error("WORK_NOT_FOUND");
      const work = workResult.rows[0];
      if (work.team_id !== team.teamId || work.control_profile_id !== profile.profileId) throw new Error("WORK_TEAM_BINDING_MISMATCH");
      if (work.status !== "open" || work.close_decision_json || expectedEpoch !== work.epoch) throw new Error("WORK_CLOSE_CONFLICT");
      const tasks = await client.query(`SELECT status FROM ${SCHEMA}.task WHERE work_id = $1`, [id]);
      const statuses = tasks.rows.map((row) => row.status);
      const terminal = statuses.every((status) => ["accepted", "blocked", "cancelled"].includes(status));
      if (!terminal || (action === "complete" && statuses.some((status) => status !== "accepted" && status !== "cancelled"))) throw new Error("WORK_CLOSE_GUARD_FAILED");
      const decisionRecord = createCoordinationDecision({
        decisionId: sha256({ scope: "work", workId: id, requestId: request, decision: action }),
        workId: id,
        decision: action,
        reason: normalizedReason,
        createdAt: this.#now(),
      });
      const timelineCount = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.work_timeline WHERE work_id = $1`, [id]);
      if (Number(timelineCount.rows[0].count) >= Math.min(profile.maxTimelineEntries, this.#maxTimelineEntries)) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED");
      const nextEpoch = work.epoch + 1;
      const sequence = await this.#nextSequence(client, id);
      const payload = { workId: id, actorId: bounded(actorId, "actorId", 256), expectedEpoch, decision: decisionRecord };
      await client.query(`UPDATE ${SCHEMA}.work SET status='closed', close_decision_json=$2::jsonb, epoch=$3, updated_at=$4 WHERE work_id=$1`, [id, rowJson(decisionRecord), nextEpoch, decisionRecord.createdAt]);
      await client.query(`INSERT INTO ${SCHEMA}.work_timeline (work_id, sequence, type, occurred_at, epoch, request_id, payload) VALUES ($1,$2,'work-closed',$3,$4,$5,$6::jsonb)`, [id, sequence, decisionRecord.createdAt, nextEpoch, request, rowJson(payload)]);
      const response = { replayed: false, decision: decisionRecord, work: publicWork(await readWork(client, id)) };
      await client.query(`INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json) VALUES ($1,'work.close',$2,$3::jsonb)`, [request, requestHash, rowJson(response)]);
      return response;
    });
  }

  async enqueueWake({ workId, taskId, targetMemberId, kind = "leader-resume", requestId, at = this.#now() } = {}) {
    if (!["task-assignment", "leader-resume", "result-notification", "human-reply"].includes(kind)) throw new Error("Unsupported outbox status");
    const normalizedRequest = identifier(requestId, "requestId");
    const wake = {
      wakeId: sha256({ kind, workId, taskId: taskId ?? null, requestId: normalizedRequest }),
      ...(workId ? { workId: identifier(workId, "workId") } : {}),
      ...(taskId ? { taskId: identifier(taskId, "taskId") } : {}),
      kind,
      targetMemberId: identifier(targetMemberId, "targetMemberId"),
      status: "pending",
      createdAt: timestamp(at, "at"),
    };
    const requestHash = commandHash("wake.enqueue", wake);
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, normalizedRequest);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const result = clone(replay.response_json); result.replayed = true; return result;
      }
      const count = await client.query(`SELECT count(*)::int AS count FROM ${SCHEMA}.wake WHERE status <> 'acked'`);
      if (Number(count.rows[0].count) >= this.#maxOutboxEntries) throw new Error("OUTBOX_LIMIT_EXCEEDED");
      await client.query(
        `INSERT INTO ${SCHEMA}.wake (wake_id, work_id, task_id, kind, target_member_id, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
        [wake.wakeId, wake.workId ?? null, wake.taskId ?? null, wake.kind, wake.targetMemberId, wake.createdAt],
      ).catch((error) => { throw dbError(error, "WAKE_ALREADY_EXISTS"); });
      const response = { replayed: false, wake };
      await client.query(`INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json) VALUES ($1,'wake.enqueue',$2,$3::jsonb)`, [normalizedRequest, requestHash, rowJson(response)]);
      return response;
    });
  }

  async claimWake({ wakeId, consumerId, requestId, at = this.#now() } = {}) {
    const id = digest(wakeId, "wakeId");
    const consumer = identifier(consumerId, "consumerId");
    const request = identifier(requestId, "requestId");
    const requestHash = commandHash("wake.claim", { wakeId: id, consumerId: consumer });
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, request);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const result = clone(replay.response_json); result.replayed = true; return result;
      }
      const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.wake WHERE wake_id = $1 FOR UPDATE`, [id]);
      if (rows.length === 0) throw new Error("WAKE_NOT_FOUND");
      const wake = wakeFromRow(rows[0]);
      if (wake.status !== "pending") throw new Error("WAKE_CLAIM_CONFLICT");
      const claimedAt = timestamp(at, "at");
      await client.query(`UPDATE ${SCHEMA}.wake SET status='claimed', consumer_id=$2, claimed_at=$3 WHERE wake_id=$1`, [id, consumer, claimedAt]);
      const response = { replayed: false, wake: { ...wake, status: "claimed", consumerId: consumer, claimedAt } };
      await client.query(`INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json) VALUES ($1,'wake.claim',$2,$3::jsonb)`, [request, requestHash, rowJson(response)]);
      return response;
    });
  }

  async ackWake({ wakeId, consumerId, receiptId, requestId, at = this.#now() } = {}) {
    const id = digest(wakeId, "wakeId");
    const consumer = identifier(consumerId, "consumerId");
    const receipt = bounded(receiptId, "receiptId", 256);
    const request = identifier(requestId, "requestId");
    const requestHash = commandHash("wake.ack", { wakeId: id, consumerId: consumer, receiptId: receipt });
    return withTransaction(this.#pool, async (client) => {
      const replay = await readReplay(client, request);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error("COMMAND_REQUEST_CONFLICT");
        const result = clone(replay.response_json); result.replayed = true; return result;
      }
      const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.wake WHERE wake_id = $1 FOR UPDATE`, [id]);
      if (rows.length === 0) throw new Error("WAKE_NOT_FOUND");
      const wake = wakeFromRow(rows[0]);
      if (wake.status !== "claimed" || wake.consumerId !== consumer) throw new Error("WAKE_ACK_CONFLICT");
      const ackedAt = timestamp(at, "at");
      await client.query(`UPDATE ${SCHEMA}.wake SET status='acked', receipt_id=$2, acked_at=$3 WHERE wake_id=$1`, [id, receipt, ackedAt]);
      const response = { replayed: false, wake: { ...wake, status: "acked", receiptId: receipt, ackedAt } };
      await client.query(`INSERT INTO ${SCHEMA}.request_replay (request_id, scope, request_hash, response_json) VALUES ($1,'wake.ack',$2,$3::jsonb)`, [request, requestHash, rowJson(response)]);
      return response;
    });
  }

  async getWork(workId) {
    const id = identifier(workId, "workId");
    const client = await this.#pool.connect();
    try {
      const entry = await readWork(client, id);
      return entry ? publicWork(entry) : undefined;
    } finally { client.release(); }
  }

  async listWorks() {
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query(`SELECT work_id FROM ${SCHEMA}.work ORDER BY created_at ASC, work_id ASC`);
      const works = [];
      for (const row of rows) {
        const entry = await readWork(client, row.work_id);
        if (entry) works.push(publicWork(entry));
      }
      return works;
    } finally { client.release(); }
  }

  async getTask(taskId) {
    const id = identifier(taskId, "taskId");
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query(`SELECT t.*, r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r ON r.task_id = t.task_id WHERE t.task_id = $1`, [id]);
      return taskFromRow(rows[0]);
    } finally { client.release(); }
  }

  async listTasks({ workId } = {}) {
    const client = await this.#pool.connect();
    try {
      const query = workId
        ? `SELECT t.*, r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r ON r.task_id = t.task_id WHERE t.work_id = $1 ORDER BY t.created_at ASC, t.task_id ASC`
        : `SELECT t.*, r.result_json FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.result r ON r.task_id = t.task_id ORDER BY t.created_at ASC, t.task_id ASC`;
      const { rows } = await client.query(query, workId ? [identifier(workId, "workId")] : []);
      return rows.map(taskFromRow);
    } finally { client.release(); }
  }

  async getResult(resultId) {
    const id = identifier(resultId, "resultId");
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query(`SELECT result_json FROM ${SCHEMA}.result WHERE result_id = $1`, [id]);
      return resultFromRow(rows[0]);
    } finally { client.release(); }
  }

  async listResults({ workId } = {}) {
    const client = await this.#pool.connect();
    try {
      const query = workId
        ? `SELECT result_json FROM ${SCHEMA}.result WHERE work_id = $1 ORDER BY created_at ASC, result_id ASC`
        : `SELECT result_json FROM ${SCHEMA}.result ORDER BY created_at ASC, result_id ASC`;
      const { rows } = await client.query(query, workId ? [identifier(workId, "workId")] : []);
      return rows.map(resultFromRow).filter(Boolean);
    } finally { client.release(); }
  }

  async getDecision(decisionId) {
    const id = identifier(decisionId, "decisionId");
    const client = await this.#pool.connect();
    try {
      const task = await client.query(`SELECT decision_json FROM ${SCHEMA}.task WHERE decision_json->>'decisionId' = $1`, [id]);
      if (task.rows[0]?.decision_json) return clone(task.rows[0].decision_json);
      const work = await client.query(`SELECT close_decision_json FROM ${SCHEMA}.work WHERE close_decision_json->>'decisionId' = $1`, [id]);
      return work.rows[0]?.close_decision_json ? clone(work.rows[0].close_decision_json) : undefined;
    } finally { client.release(); }
  }

  async listDecisions({ workId, taskId } = {}) {
    const client = await this.#pool.connect();
    try {
      const params = [];
      const filters = [];
      if (workId !== undefined) { params.push(identifier(workId, "workId")); filters.push(`work_id = $${params.length}`); }
      if (taskId !== undefined) { params.push(identifier(taskId, "taskId")); filters.push(`task_id = $${params.length}`); }
      const taskQuery = `SELECT decision_json FROM ${SCHEMA}.task WHERE decision_json IS NOT NULL${filters.length ? ` AND ${filters.join(" AND ")}` : ""}`;
      const taskRows = await client.query(taskQuery, params);
      const workParams = workId !== undefined ? [identifier(workId, "workId")] : [];
      const workRows = taskId === undefined
        ? await client.query(`SELECT close_decision_json FROM ${SCHEMA}.work WHERE close_decision_json IS NOT NULL${workId !== undefined ? " AND work_id = $1" : ""}`, workParams)
        : { rows: [] };
      return [...taskRows.rows.map((row) => clone(row.decision_json)), ...workRows.rows.map((row) => clone(row.close_decision_json))]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.decisionId.localeCompare(right.decisionId));
    } finally { client.release(); }
  }

  async getWake(wakeId) {
    const id = digest(wakeId, "wakeId");
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.wake WHERE wake_id = $1`, [id]);
      return rows[0] ? wakeFromRow(rows[0]) : undefined;
    } finally { client.release(); }
  }

  async listOutbox({ status } = {}) {
    if (status !== undefined && !["pending", "claimed", "acked"].includes(status)) throw new Error("Unsupported outbox status");
    const client = await this.#pool.connect();
    try {
      const query = status ? `SELECT * FROM ${SCHEMA}.wake WHERE status = $1 ORDER BY created_at ASC, wake_id ASC` : `SELECT * FROM ${SCHEMA}.wake ORDER BY created_at ASC, wake_id ASC`;
      const { rows } = await client.query(query, status ? [status] : []);
      return rows.map(wakeFromRow);
    } finally { client.release(); }
  }

  async health() {
    const client = await this.#pool.connect();
    try {
      const result = await client.query(`SELECT (SELECT count(*) FROM ${SCHEMA}.work)::int AS work_count, (SELECT count(*) FROM ${SCHEMA}.task)::int AS task_count, (SELECT count(*) FROM ${SCHEMA}.wake)::int AS outbox_count`);
      const row = result.rows[0];
      return { workCount: Number(row.work_count), taskCount: Number(row.task_count), outboxCount: Number(row.outbox_count), backend: "postgres" };
    } finally { client.release(); }
  }
}
