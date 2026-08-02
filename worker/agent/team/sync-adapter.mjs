// Leader storage-sync adapter.
//
// AgentTeams v1.2.0 backs the shared filesystem (/root/agentteams-fs/shared)
// with MinIO and synchronizes it across Workers via the file-sync skill's
// agentteams-sync tool. A Worker must sync before reading cross-worker state
// (e.g. a submitted result) so it sees the latest digest-verified manifest.
//
// For the leader roundtrip spike the Leader only writes its own bindings
// (create project, dispatch task), so beforeRead is not exercised; this adapter
// is a tolerant no-op that does not block the turn. The real agentteams-sync
// invocation (the skill script is loaded at runtime under
// /root/agentteams-fs/agents/<worker>/skills/file-sync) is wired with the full
// multi-turn roundtrip where the Leader reads a Worker-submitted result.

export function createLeaderSync() {
  return {
    async beforeRead() {
      // gate 3: no cross-worker reads on the Leader's own write path.
    },
  };
}
