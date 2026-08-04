import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ChangeRevisionStore } from "../agent/runner/revision-store.mjs";

const TASK_ID = "task-implement-0";
const INVOCATION = "a".repeat(64);

function archiveFile(relativePath, content, executable = false) {
  const bytes = Buffer.from(content);
  return `${JSON.stringify([
    "f",
    relativePath,
    executable,
    bytes.length,
    createHash("sha256").update(bytes).digest("hex"),
    bytes.toString("base64"),
  ])}\n`;
}

async function makeWritable(root) {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) await makeWritable(path.join(root, entry));
  } else {
    await chmod(root, 0o600);
  }
}

async function fixture(t, archive = archiveFile("input.txt", "sealed\n")) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "tiangong-revision-store-test-"));
  t.after(async () => {
    await makeWritable(rootDir);
    await rm(rootDir, { recursive: true, force: true });
  });
  const calls = [];
  const runDocker = async (args) => {
    calls.push([...args]);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: archive,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  };
  return { rootDir, calls, store: new ChangeRevisionStore({ rootDir, runDocker }) };
}

test("ChangeRevisionStore seals one invocation and independently verifies its immutable artifact", async (t) => {
  const { store, calls } = await fixture(t);
  const ref = await store.capture({
    containerName: "runner-container",
    producerTaskId: TASK_ID,
    revision: 0,
    invocationKey: INVOCATION,
  });
  assert.equal(ref.producerTaskId, TASK_ID);
  assert.equal(ref.revision, 0);
  assert.match(ref.artifactDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(calls[0].slice(0, 7), [
    "container", "exec", "--user", "65532:65532", "--workdir", "/workspace/scratch/revision",
    "runner-container",
  ]);

  const materialized = await store.lookup(TASK_ID);
  assert.equal(materialized.ref.contentDigest, ref.contentDigest);
  assert.equal(await lstat(materialized.directory).then((value) => value.mode & 0o777), 0o500);
  assert.equal(await store.capture({
    containerName: "runner-container",
    producerTaskId: TASK_ID,
    revision: 0,
    invocationKey: INVOCATION,
  }).then((value) => value.contentDigest), ref.contentDigest);
  assert.equal(calls.length, 1);
  await assert.rejects(
    () => store.assertAvailable(TASK_ID, "b".repeat(64)),
    /different immutable ChangeRevision/u,
  );

  const artifact = path.join(materialized.directory, "input.txt");
  await chmod(artifact, 0o600);
  await writeFile(artifact, "tampered\n");
  await assert.rejects(() => store.lookup(TASK_ID), /artifact digest/u);
});

test("ChangeRevisionStore rejects ambiguous, escaping, and truncated archives", async (t) => {
  const cases = [
    archiveFile("../escape", "x"),
    `${archiveFile("same", "x")}${archiveFile("same", "x")}`,
    `${JSON.stringify(["f", "bad", false, 1, "0".repeat(64), "eA=="])}\n`,
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const { store } = await fixture(t, cases[index]);
    await assert.rejects(
      () => store.capture({
        containerName: `runner-${index}`,
        producerTaskId: `task-${index}`,
        revision: 0,
        invocationKey: String(index + 1).repeat(64),
      }),
    );
  }
});
