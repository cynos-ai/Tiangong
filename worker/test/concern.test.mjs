import assert from "node:assert/strict";
import test from "node:test";

import { CONCERN_SEVERITIES, createConcern, emitConcerns } from "../agent/concern/concern.mjs";

const AT = "2026-08-01T12:00:00Z";
const fixedNow = () => AT;

test("createConcern validates, freezes, and digests a non-authoritative hint", () => {
  const c = createConcern({ concernId: "c1", severity: "warning", code: "accept-without-evidence", message: "no evidence", at: AT });
  assert.equal(c.kind, "tiangong.concern");
  assert.equal(Object.isFrozen(c), true);
  assert.match(c.contentDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(CONCERN_SEVERITIES, ["info", "warning"]);
});

test("createConcern rejects an unsupported severity and a malformed id", () => {
  assert.throws(
    () => createConcern({ concernId: "c1", severity: "critical", code: "x", message: "m", at: AT }),
    /Unsupported severity/,
  );
  assert.throws(
    () => createConcern({ concernId: "bad id!", severity: "info", code: "x", message: "m", at: AT }),
    /invalid format/,
  );
});

test("emitConcerns flags a claim with no Evidence and no artifact", () => {
  const concerns = emitConcerns(
    {
      resultEnvelope: {
        taskKind: "implement",
        claim: "done",
        evidenceRefs: [],
        artifactRefs: [],
        projectId: "p1",
        taskId: "t1",
      },
    },
    { now: fixedNow },
  );
  const codes = concerns.map((c) => c.code);
  assert.ok(codes.includes("accept-without-evidence"));
  assert.ok(codes.includes("claim-without-artifact"));
  for (const c of concerns) assert.equal(c.severity, "warning");
});

test("emitConcerns stays quiet when Evidence and artifacts are present", () => {
  const concerns = emitConcerns(
    {
      resultEnvelope: {
        taskKind: "implement",
        claim: "done",
        evidenceRefs: ["ev-1"],
        artifactRefs: ["art-1"],
        projectId: "p1",
        taskId: "t1",
      },
    },
    { now: fixedNow },
  );
  assert.equal(concerns.length, 0);
});

test("emitConcerns warns when revision waves are nearly exhausted", () => {
  const concerns = emitConcerns(
    { chain: [{ decision: "revision" }, { decision: "revision" }], maxRevisionWaves: 2, projectId: "p1" },
    { now: fixedNow },
  );
  assert.ok(concerns.some((c) => c.code === "revision-waves-nearly-exhausted"));
});

test("emitConcerns flags a blocked WorkRun", () => {
  const concerns = emitConcerns({ workRunPhase: "blocked", taskId: "t1" }, { now: fixedNow });
  assert.ok(concerns.some((c) => c.code === "work-run-blocked"));
});

test("a blocker result does not trigger the no-evidence concern", () => {
  const concerns = emitConcerns(
    { resultEnvelope: { taskKind: "implement", blocker: "stuck", evidenceRefs: [], artifactRefs: [], projectId: "p1", taskId: "t1" } },
    { now: fixedNow },
  );
  assert.equal(concerns.some((c) => c.code === "accept-without-evidence"), false);
});
