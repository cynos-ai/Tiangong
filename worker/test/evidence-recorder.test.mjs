import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";

async function evidenceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "events.jsonl");
}

test("evidence hash chain continues across recorder restart", async (t) => {
  const filePath = await evidenceFixture(t);
  const timestamps = [new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:01.000Z")];
  let recorder = new EvidenceRecorder({ filePath, clock: () => timestamps.shift() });
  const first = await recorder.append({ type: "tool.proposed", toolCallId: "call-1" });
  recorder = new EvidenceRecorder({ filePath, clock: () => timestamps.shift() });
  const second = await recorder.append({ type: "gate.decided", toolCallId: "call-1", decision: "allow" });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.previousHash, first.hash);
  assert.equal((await recorder.readAll()).length, 2);
});

test("evidence tampering is detected before append", async (t) => {
  const filePath = await evidenceFixture(t);
  const recorder = new EvidenceRecorder({ filePath });
  await recorder.append({ type: "tool.proposed", toolCallId: "call-1" });
  const text = await readFile(filePath, "utf8");
  await writeFile(filePath, text.replace("call-1", "call-x"));

  const restarted = new EvidenceRecorder({ filePath });
  await assert.rejects(restarted.initialize(), /Evidence hash mismatch/u);
});

test("callers cannot override evidence chain fields", async (t) => {
  const recorder = new EvidenceRecorder({ filePath: await evidenceFixture(t) });
  await assert.rejects(
    recorder.append({ type: "tool.proposed", sequence: 10 }),
    /reserved field/u,
  );
});
