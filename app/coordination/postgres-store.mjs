import { readFile } from "node:fs/promises";

import {
  isControlProfile,
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
    timeline: await readTimeline(client, workId),
  };
}

function publicWork(entry) {
  return clone({
    work: entry.work,
    epoch: entry.epoch,
    status: entry.status,
    currentWorkSpec: entry.currentWorkSpec,
    timeline: entry.timeline,
  });
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
    return withTransaction(this.#pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('tiangong_coordination.migrations'))");
      await client.query(migrationSql);
      return { version: "001_coordination" };
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
      if (row.epoch + 1 > this.#maxTimelineEntries) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED");
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
      const result = await client.query(`SELECT (SELECT count(*) FROM ${SCHEMA}.work)::int AS work_count, (SELECT count(*) FROM ${SCHEMA}.wake)::int AS outbox_count`);
      const row = result.rows[0];
      return { workCount: Number(row.work_count), taskCount: 0, outboxCount: Number(row.outbox_count), backend: "postgres" };
    } finally { client.release(); }
  }
}
