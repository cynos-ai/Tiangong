// Leader channel adapter: the AgentTeams @mention side effect.
//
// AgentTeams carries Worker->Worker coordination as Matrix m.room.message
// events in the Team Room: a message whose body contains the target's full
// MXID and whose m.mentions lists it wakes the target Worker (verified by the
// peer-mention oracle). The Tiangong Leader emits its turn output through
// OpenClaw, which relays it as that Matrix message.
//
// For the leader roundtrip spike this adapter records the queued mention as
// Evidence (the binding is written; the @mention is carried by the Leader's
// turn output). It never falsely claims Matrix delivery. Deterministic
// mention-text emission (like peer-transport) and the assignee->MXID mapping
// land with the full multi-turn roundtrip.

function nowISO(now) {
  const value = typeof now === "function" ? now() : undefined;
  return typeof value === "string" ? value : new Date().toISOString();
}

export function createLeaderChannel({ evidence, now } = {}) {
  const queued = [];
  return {
    queued,
    notifyAssignee(assignee, taskId, digest) {
      queued.push({ kind: "notifyAssignee", assignee, taskId, digest });
      evidence?.append?.({
        type: "team.mention.queued",
        target: assignee,
        taskId,
        mentionDigest: digest,
        at: nowISO(now),
      });
    },
    notifyLeader(taskId, digest) {
      queued.push({ kind: "notifyLeader", taskId, digest });
      evidence?.append?.({
        type: "team.mention.queued",
        target: "team_leader",
        taskId,
        mentionDigest: digest,
        at: nowISO(now),
      });
    },
    reportToRequester(projectId, summary, disposition) {
      queued.push({ kind: "reportToRequester", projectId, disposition });
      evidence?.append?.({
        type: "team.report.queued",
        projectId,
        disposition,
        at: nowISO(now),
      });
    },
  };
}
