import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("independent recorder instances serialize without forking the hash chain", async (t) => {
  const filePath = await evidenceFixture(t);
  const firstProcess = new EvidenceRecorder({ filePath });
  const secondProcess = new EvidenceRecorder({ filePath });

  const first = await firstProcess.append({ type: "one" });
  const second = await secondProcess.append({ type: "two" });
  const third = await firstProcess.append({ type: "three" });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.previousHash, first.hash);
  assert.equal(third.sequence, 3);
  assert.equal(third.previousHash, second.hash);
  assert.equal((await secondProcess.readAll()).length, 3);
});

test("Evidence rotates into hash-linked segments without breaking verification", async (t) => {
  const filePath = await evidenceFixture(t);
  const recorder = new EvidenceRecorder({ filePath, maxSegmentBytes: 1 });
  await recorder.append({ type: "one" });
  await recorder.append({ type: "two" });
  await recorder.append({ type: "three" });

  const files = await readdir(dirname(filePath));
  assert.equal(files.filter((name) => name.includes(".segment-")).length, 2);
  const restarted = new EvidenceRecorder({ filePath, maxSegmentBytes: 1 });
  const records = await restarted.readAll();
  assert.deepEqual(records.map((entry) => entry.type), ["one", "two", "three"]);
  assert.deepEqual(records.map((entry) => entry.sequence), [1, 2, 3]);
  assert.equal(records[1].previousHash, records[0].hash);
  assert.equal(records[2].previousHash, records[1].hash);
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
