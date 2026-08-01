import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson, sha256 } from "../agent/canonical-json.mjs";
import { CapturedArtifactError } from "../agent/artifacts/errors.mjs";
import { enforceArtifactQuota } from "../agent/artifacts/quota.mjs";
import {
  CONTENT_IDENTITY_KEYS,
  MAX_ARTIFACTS_PER_OPERATION,
  MAX_ARTIFACTS_PER_RUN,
  MAX_ARTIFACTS_PER_SESSION,
  MAX_ARTIFACTS_PER_TARGET,
  MAX_CONTENT_BYTES_PER_RUN,
  MAX_CONTENT_BYTES_PER_SESSION,
  MAX_CONTENT_BYTES_PER_TARGET,
  evidenceMetadataFromReceipt,
} from "../agent/artifacts/schema.mjs";
import { CapturedArtifactStore } from "../agent/artifacts/store.mjs";
import { withKernelFileLock } from "../agent/persistence/kernel-file-lock.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_ID = "artifact-session";
const ACTOR = "@reviewer:example.test";
const RUN_ID = "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_ID = "target-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIRST_UUID = "11111111-1111-4111-8111-111111111111";
const SECOND_UUID = "22222222-2222-4222-8222-222222222222";

function generatedUuid(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function goldenDigest(left, right) {
  return `${left}${right}`;
}

async function fixture(t, { uuids = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-artifact-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  let uuidIndex = 0;
  let clockTick = 0;
  const randomUUID = uuids
    ? () => uuids[uuidIndex++]
    : () => generatedUuid(++uuidIndex);
  const clock = () => new Date(Date.UTC(2026, 6, 31, 0, 0, clockTick++));
  const options = { stateDirectory, sessionId: SESSION_ID, randomUUID, clock };
  const store = new CapturedArtifactStore(options);
  const paths = statePathsForSession({ stateDirectory, sessionId: SESSION_ID });
  return { root, stateDirectory, options, store, paths };
}

function binding(store, overrides = {}) {
  return {
    kind: "practice_target",
    sessionHash: store.sessionHash,
    actorId: ACTOR,
    practiceRunId: RUN_ID,
    targetId: TARGET_ID,
    invocationIdentity: sha256("invocation-one"),
    sourceOperationDigest: sha256("operation-one"),
    ...overrides,
  };
}

function putInput(store, overrides = {}) {
  return {
    binding: binding(store),
    purpose: "review_target_chunk",
    ordinal: 0,
    mediaType: "text/plain;charset=utf-8",
    encoding: "utf-8",
    truncated: false,
    producerId: "review-target-consume",
    producerVersion: 1,
    transformVersion: 1,
    canonicalBytes: Buffer.from("alpha\n"),
    ...overrides,
  };
}

function expectedIdentity(receipt) {
  return Object.freeze(Object.fromEntries(
    CONTENT_IDENTITY_KEYS.map((key) => [key, receipt[key]]),
  ));
}

function evidenceRead(receipt, expectedBinding = receipt.binding) {
  return {
    artifactRefDigest: receipt.artifactRefDigest,
    artifactKey: receipt.artifactKey,
    expectedBinding,
    expectedContentIdentity: expectedIdentity(receipt),
  };
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error instanceof CapturedArtifactError, true);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(ACTOR), false);
      assert.equal(error.message.includes(RUN_ID), false);
      return true;
    },
  );
}

function mode(stat) {
  return stat.mode & 0o777;
}

async function objectPaths(f, receipt) {
  const directory = join(f.paths.capturedArtifactObjectsDirectory, receipt.artifactKey);
  return {
    directory,
    content: join(directory, "content"),
    envelope: join(directory, "envelope.json"),
  };
}

function runNode(script, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
      cwd: WORKER_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`child failed (${code ?? signal}): ${stderr}`));
    });
  });
}

test("put freezes the golden identities and persists the exact private object layout", async (t) => {
  const f = await fixture(t, { uuids: [FIRST_UUID, SECOND_UUID] });
  const receipt = await f.store.put(putInput(f.store));
  assert.deepEqual(
    {
      sessionHash: f.store.sessionHash,
      artifactKey: receipt.artifactKey,
      artifactRefDigest: receipt.artifactRefDigest,
      contentDigest: receipt.contentDigest,
    },
    {
      sessionHash: goldenDigest(
        "39dfde5ff405b18791c4194b60b26551",
        "b22fdb999bc5c392b2aae27067c25368",
      ),
      artifactKey: goldenDigest(
        "b559d2b77381fbe0c31ae548cc04d0f",
        "3e30f65b2a1b819c621c21bc73cbc121e",
      ),
      artifactRefDigest: goldenDigest(
        "54eff5dff4c3040ceb85b75eef1f36d1",
        "b783f7b5e4dc0beb5656c2ccf42a3e6b",
      ),
      contentDigest: goldenDigest(
        "b6a98d9ce9a2d9149288fa3df42d377",
        "c3e42737afdcdaf714e33c0a100b51060",
      ),
    },
  );
  assert.equal(receipt.artifactRef, `artifact-v1/artifact-${FIRST_UUID}`);
  assert.equal(receipt.contentBytes, 6);
  assert.equal(receipt.contentLines, 2);
  assert.equal(receipt.replayed, false);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.binding), true);

  const paths = await objectPaths(f, receipt);
  assert.deepEqual((await readdir(paths.directory)).sort(), ["content", "envelope.json"]);
  assert.equal((await readFile(paths.content, "utf8")), "alpha\n");
  const envelopeWire = await readFile(paths.envelope);
  const envelope = JSON.parse(envelopeWire.toString("utf8"));
  assert.equal(envelopeWire.equals(Buffer.from(canonicalJson(envelope), "utf8")), true);
  assert.equal(
    envelope.envelopeDigest,
    goldenDigest("59381a3bda511561eaf757d87c825ae7", "7e06a0dccc541ed3093fffe56808410d"),
  );
  assert.equal(mode(await lstat(f.paths.capturedArtifactsRoot)), 0o700);
  assert.equal(mode(await lstat(f.paths.capturedArtifactDirectory)), 0o700);
  assert.equal(mode(await lstat(paths.directory)), 0o700);
  assert.equal(mode(await lstat(paths.content)), 0o600);
  assert.equal(mode(await lstat(paths.envelope)), 0o600);

  const fromJournal = await f.store.readFromJournal({
    artifactRef: receipt.artifactRef,
    ...evidenceRead(receipt),
  });
  assert.equal(fromJournal.bytes.toString("utf8"), "alpha\n");
  assert.notEqual(fromJournal.bytes, putInput(f.store).canonicalBytes);
  assert.equal(Object.isFrozen(fromJournal.envelope), true);
});

test("binding, producer, metadata, byte, UTF-8 and text-policy validation follow stable precedence", async (t) => {
  const f = await fixture(t);
  await expectCode(
    f.store.put(putInput(f.store, {
      binding: binding(f.store, { sessionHash: sha256("another-session") }),
      producerId: "unknown-producer",
    })),
    "ARTIFACT_BINDING_INVALID",
  );
  await expectCode(
    f.store.put(putInput(f.store, { producerId: "unknown-producer" })),
    "ARTIFACT_PRODUCER_NOT_ALLOWED",
  );
  await expectCode(
    f.store.put({ ...putInput(f.store), unknown: true }),
    "ARTIFACT_METADATA_INVALID",
  );
  await expectCode(
    f.store.put(putInput(f.store, { canonicalBytes: Buffer.alloc((50 * 1024) + 1, 0x61) })),
    "ARTIFACT_LIMIT_EXCEEDED",
  );
  await expectCode(
    f.store.put(putInput(f.store, { canonicalBytes: Buffer.from([0xc3, 0x28]) })),
    "ARTIFACT_METADATA_INVALID",
  );
  await expectCode(
    f.store.put(putInput(f.store, { canonicalBytes: Buffer.from([0x61, 0x00]) })),
    "ARTIFACT_METADATA_INVALID",
  );
  const manifestInput = {
    ...putInput(f.store),
    purpose: "directory_manifest",
    mediaType: "application/vnd.tiangong.directory-manifest+json;version=1",
    producerId: "review-directory-capture",
    canonicalBytes: Buffer.from(canonicalJson({
      schemaVersion: 1,
      kind: "directory-manifest",
      rootPath: ".",
      selectionDigest: sha256("selection"),
      members: [{
        path: "one.txt",
        contentDigest: sha256("one"),
        contentBytes: 3,
        contentLines: 1,
        encoding: "utf-8",
        requiredConsumeSegments: 1,
      }],
    }), "utf8"),
  };
  await expectCode(
    f.store.put({ ...manifestInput, canonicalBytes: Buffer.from("{}", "utf8") }),
    "ARTIFACT_METADATA_INVALID",
  );
  await expectCode(
    f.store.put({ ...manifestInput, canonicalBytes: Buffer.concat([Buffer.from(" "), manifestInput.canonicalBytes]) }),
    "ARTIFACT_METADATA_INVALID",
  );
  const manifest = await f.store.put(manifestInput);
  assert.equal((await f.store.readFromEvidence(evidenceRead(manifest))).bytes.equals(manifestInput.canonicalBytes), true);
  const commitManifestInput = {
    ...putInput(f.store),
    purpose: "git_tree_manifest",
    ordinal: 1,
    mediaType: "application/vnd.tiangong.git-tree-manifest+json;version=1",
    producerId: "review-git-commit-capture",
    truncated: false,
    canonicalBytes: Buffer.from(canonicalJson({
      schemaVersion: 1,
      kind: "git-tree-manifest",
      repositoryPath: ".",
      objectFormat: "sha1",
      commitOid: "a".repeat(40),
      treeOid: "b".repeat(40),
      selectionDigest: sha256("git-selection"),
      members: [{
        path: "src/one.txt",
        mode: "100644",
        blobOid: "c".repeat(40),
        contentDigest: sha256("git-one"),
        contentBytes: 4,
        contentLines: 2,
        encoding: "utf-8",
        requiredConsumeSegments: 1,
      }],
    }), "utf8"),
  };
  assert.equal((await f.store.put(commitManifestInput)).producerId, "review-git-commit-capture");
  await expectCode(
    f.store.put({ ...commitManifestInput, ordinal: 2, canonicalBytes: Buffer.from("{}") }),
    "ARTIFACT_METADATA_INVALID",
  );
  const gitDiffInput = putInput(f.store, {
    purpose: "git_diff",
    ordinal: 3,
    mediaType: "text/x-diff;charset=utf-8",
    producerId: "review-git-diff-capture",
    truncated: false,
    canonicalBytes: Buffer.from("diff --git a/src/one.txt b/src/one.txt\n"),
  });
  assert.equal((await f.store.put(gitDiffInput)).producerId, "review-git-diff-capture");
  await expectCode(
    f.store.put({
      ...gitDiffInput,
      ordinal: 30,
      canonicalBytes: Buffer.from("diff --git a/src/one.txt b/src/two.txt\n"),
    }),
    "ARTIFACT_METADATA_INVALID",
  );
  await expectCode(
    f.store.put({
      ...gitDiffInput,
      ordinal: 31,
      canonicalBytes: Buffer.from("diff --git a/src/one.txt b/src/one.txt\nGIT binary patch\n"),
    }),
    "ARTIFACT_METADATA_INVALID",
  );
  const contentMarkerDiff = Buffer.from(
    "diff --git a/src/one.txt b/src/one.txt\n--- a/src/one.txt\n+++ b/src/one.txt\n@@ -1 +1 @@\n-docs about Submodule support\n+docs about GIT binary patch content\n",
  );
  assert.equal((await f.store.put({
    ...gitDiffInput,
    ordinal: 32,
    canonicalBytes: contentMarkerDiff,
  })).producerId, "review-git-diff-capture");
  const gitList = Buffer.from(canonicalJson({
    schemaVersion: 1,
    kind: "git-commit-list",
    targetId: binding(f.store).targetId,
    prefix: "src",
    offset: 0,
    returnedCount: 1,
    totalMatchingMembers: 1,
    truncated: false,
    members: [{ path: "src/one.txt", mode: "100644", contentBytes: 4, contentLines: 2 }],
  }));
  assert.equal((await f.store.put(putInput(f.store, {
    purpose: "git_commit_list",
    ordinal: 4,
    mediaType: "application/vnd.tiangong.git-commit-list+json;version=1",
    producerId: "review-git-inspect",
    truncated: false,
    canonicalBytes: gitList,
  }))).producerId, "review-git-inspect");
  const empty = await f.store.put(putInput(f.store, {
    ordinal: 5,
    canonicalBytes: Buffer.alloc(0),
  }));
  assert.equal(empty.contentBytes, 0);
  assert.equal(empty.contentLines, 1);
});

test("an invalid injected timestamp fails before creating a final object", async (t) => {
  const f = await fixture(t);
  const invalidClockStore = new CapturedArtifactStore({
    stateDirectory: f.stateDirectory,
    sessionId: SESSION_ID,
    randomUUID: () => generatedUuid(500),
    clock: () => new Date(Date.UTC(10_000, 0, 1)),
  });
  await expectCode(
    invalidClockStore.put(putInput(invalidClockStore)),
    "ARTIFACT_WRITE_FAILED",
  );
  assert.deepEqual(await readdir(f.paths.capturedArtifactObjectsDirectory), []);
});

test("same-key replay is exact while valid different bytes conflict without another object", async (t) => {
  const f = await fixture(t);
  const first = await f.store.put(putInput(f.store));
  const replay = await new CapturedArtifactStore(f.options).put(putInput(f.store));
  assert.equal(replay.replayed, true);
  assert.equal(replay.artifactRef, first.artifactRef);
  assert.equal((await readdir(f.paths.capturedArtifactObjectsDirectory)).length, 1);
  await expectCode(
    f.store.put(putInput(f.store, { canonicalBytes: Buffer.from("omega\n") })),
    "ARTIFACT_KEY_CONFLICT",
  );
  assert.equal((await readdir(f.paths.capturedArtifactObjectsDirectory)).length, 1);
});

test("full-store structure validation repairs modes and rejects unrelated extra entries", async (t) => {
  const f = await fixture(t);
  const first = await f.store.put(putInput(f.store));
  const second = await f.store.put(putInput(f.store, { ordinal: 1, canonicalBytes: Buffer.from("beta\n") }));
  const firstPaths = await objectPaths(f, first);
  const secondPaths = await objectPaths(f, second);
  await chmod(firstPaths.content, 0o4666);
  const read = await f.store.readFromEvidence(evidenceRead(first));
  assert.equal(read.bytes.toString("utf8"), "alpha\n");
  assert.equal(mode(await lstat(firstPaths.content)), 0o600);
  await writeFile(join(secondPaths.directory, "extra"), "not allowed", { mode: 0o600 });
  await expectCode(
    f.store.readFromEvidence(evidenceRead(first)),
    "ARTIFACT_STORE_CORRUPTED",
  );
});

test("selected content, canonical envelope and no-symlink checks fail closed", async (t) => {
  const f = await fixture(t);
  const receipt = await f.store.put(putInput(f.store));
  const paths = await objectPaths(f, receipt);
  await writeFile(paths.content, "alpHa\n", { mode: 0o600 });
  await expectCode(
    f.store.readFromEvidence(evidenceRead(receipt)),
    "ARTIFACT_STORE_CORRUPTED",
  );

  const f2 = await fixture(t);
  const receipt2 = await f2.store.put(putInput(f2.store));
  const paths2 = await objectPaths(f2, receipt2);
  const envelope = await readFile(paths2.envelope, "utf8");
  await writeFile(paths2.envelope, `${envelope}\n`, { mode: 0o600 });
  await expectCode(
    f2.store.readFromEvidence(evidenceRead(receipt2)),
    "ARTIFACT_STORE_CORRUPTED",
  );

  const f3 = await fixture(t);
  const receipt3 = await f3.store.put(putInput(f3.store));
  const paths3 = await objectPaths(f3, receipt3);
  await rm(paths3.content);
  await symlink("/etc/passwd", paths3.content);
  await expectCode(
    f3.store.readFromEvidence(evidenceRead(receipt3)),
    "ARTIFACT_STORE_CORRUPTED",
  );
});

test("restart cleanup accepts one bounded partial temp and rejects multiple residue", async (t) => {
  const f = await fixture(t);
  const receipt = await f.store.put(putInput(f.store));
  const partial = join(f.paths.capturedArtifactTemporaryDirectory, `tmp-${generatedUuid(900)}`);
  await mkdir(partial, { mode: 0o700 });
  await writeFile(join(partial, "content"), "partial", { mode: 0o600 });
  const read = await new CapturedArtifactStore(f.options).readFromEvidence(evidenceRead(receipt));
  assert.equal(read.bytes.toString("utf8"), "alpha\n");
  assert.deepEqual(await readdir(f.paths.capturedArtifactTemporaryDirectory), []);

  for (const index of [901, 902]) {
    await mkdir(join(f.paths.capturedArtifactTemporaryDirectory, `tmp-${generatedUuid(index)}`), {
      mode: 0o700,
    });
  }
  await expectCode(
    f.store.readFromEvidence(evidenceRead(receipt)),
    "ARTIFACT_STORE_CORRUPTED",
  );
});

test("journal and Evidence reads require exact authority joins across restart and session isolation", async (t) => {
  const f = await fixture(t);
  const receipt = await f.store.put(putInput(f.store));
  const restarted = new CapturedArtifactStore(f.options);
  assert.equal(
    (await restarted.readFromEvidence(evidenceRead(receipt))).bytes.toString("utf8"),
    "alpha\n",
  );
  await mkdir(f.paths.piDirectory, { recursive: true });
  await writeFile(join(f.paths.piDirectory, "session.jsonl"), "transcript\n");
  await rm(f.paths.sessionsRoot, { recursive: true, force: true });
  assert.equal(
    (await restarted.readFromEvidence(evidenceRead(receipt))).bytes.toString("utf8"),
    "alpha\n",
  );
  await expectCode(
    restarted.readFromEvidence({
      ...evidenceRead(receipt),
      expectedBinding: binding(restarted, { actorId: "@other:example.test" }),
    }),
    "ARTIFACT_STORE_CORRUPTED",
  );
  await expectCode(
    restarted.readFromJournal({
      artifactRef: `artifact-v1/artifact-${generatedUuid(700)}`,
      ...evidenceRead(receipt),
    }),
    "ARTIFACT_STORE_CORRUPTED",
  );

  const other = new CapturedArtifactStore({
    stateDirectory: f.stateDirectory,
    sessionId: "another-session",
  });
  await expectCode(
    other.readFromEvidence({
      ...evidenceRead(receipt),
      expectedBinding: binding(other),
    }),
    "ARTIFACT_STORE_CORRUPTED",
  );
});

test("independent processes serialize same-key put into one durable object", async (t) => {
  const f = await fixture(t);
  const storeModule = pathToFileURL(join(WORKER_ROOT, "agent", "artifacts", "store.mjs")).href;
  const canonicalModule = pathToFileURL(join(WORKER_ROOT, "agent", "canonical-json.mjs")).href;
  const script = `
    import { CapturedArtifactStore } from ${JSON.stringify(storeModule)};
    import { sha256 } from ${JSON.stringify(canonicalModule)};
    process.umask(0o777);
    const stateDirectory = process.argv[1];
    const store = new CapturedArtifactStore({ stateDirectory, sessionId: ${JSON.stringify(SESSION_ID)} });
    const binding = {
      kind: "practice_target", sessionHash: store.sessionHash,
      actorId: ${JSON.stringify(ACTOR)}, practiceRunId: ${JSON.stringify(RUN_ID)},
      targetId: ${JSON.stringify(TARGET_ID)}, invocationIdentity: sha256("invocation-one"),
      sourceOperationDigest: sha256("operation-one")
    };
    const receipt = await store.put({ binding, purpose: "review_target_chunk", ordinal: 0,
      mediaType: "text/plain;charset=utf-8", encoding: "utf-8", truncated: false,
      producerId: "review-target-consume", producerVersion: 1, transformVersion: 1,
      canonicalBytes: Buffer.from("alpha\\n") });
    process.stdout.write(JSON.stringify({ replayed: receipt.replayed, artifactRef: receipt.artifactRef }));
  `;
  const [left, right] = await Promise.all([
    runNode(script, [f.stateDirectory]),
    runNode(script, [f.stateDirectory]),
  ]);
  const results = [JSON.parse(left), JSON.parse(right)];
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(results[0].artifactRef, results[1].artifactRef);
  assert.equal((await readdir(f.paths.capturedArtifactObjectsDirectory)).length, 1);
});

test("kernel flock excludes a distinct open description and releases without stale reclaim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-kernel-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "lock");
  const firstHandle = await openFile(path, "a+", 0o600);
  const secondHandle = await openFile(path, "a+", 0o600);
  t.after(() => firstHandle.close().catch(() => {}));
  t.after(() => secondHandle.close().catch(() => {}));
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolvePromise) => { enteredResolve = resolvePromise; });
  const release = new Promise((resolvePromise) => { releaseResolve = resolvePromise; });
  const first = withKernelFileLock(firstHandle, async () => {
    enteredResolve();
    await release;
  }, { timeoutSeconds: 1 });
  await entered;
  await expectCode(
    withKernelFileLock(secondHandle, async () => {}, { timeoutSeconds: 0.05 }),
    "ARTIFACT_LOCK_FAILED",
  );
  releaseResolve();
  await first;
  await withKernelFileLock(secondHandle, async () => {}, { timeoutSeconds: 1 });
});

test("quota boundaries accept the adjacent value and reject every aggregate dimension", () => {
  const contentBytes = 7;
  const usage = {
    session: {
      count: MAX_ARTIFACTS_PER_SESSION - 1,
      contentBytes: MAX_CONTENT_BYTES_PER_SESSION - contentBytes,
    },
    run: {
      count: MAX_ARTIFACTS_PER_RUN - 1,
      contentBytes: MAX_CONTENT_BYTES_PER_RUN - contentBytes,
    },
    target: {
      count: MAX_ARTIFACTS_PER_TARGET - 1,
      contentBytes: MAX_CONTENT_BYTES_PER_TARGET - contentBytes,
    },
    operation: { count: MAX_ARTIFACTS_PER_OPERATION - 1, contentBytes: 0 },
  };
  assert.doesNotThrow(() => enforceArtifactQuota(usage, contentBytes));
  for (const mutate of [
    (copy) => { copy.session.count += 1; },
    (copy) => { copy.session.contentBytes += 1; },
    (copy) => { copy.run.count += 1; },
    (copy) => { copy.run.contentBytes += 1; },
    (copy) => { copy.target.count += 1; },
    (copy) => { copy.target.contentBytes += 1; },
    (copy) => { copy.operation.count += 1; },
  ]) {
    const copy = structuredClone(usage);
    mutate(copy);
    assert.throws(
      () => enforceArtifactQuota(copy, contentBytes),
      (error) => error instanceof CapturedArtifactError && error.code === "ARTIFACT_QUOTA_EXCEEDED",
    );
  }
});

test("artifact ID collisions stop after eight attempts and safe Evidence metadata omits authority-bearing ref", async (t) => {
  const collision = generatedUuid(300);
  const f = await fixture(t, {
    uuids: [
      collision,
      generatedUuid(301),
      ...Array.from({ length: 8 }, () => collision),
    ],
  });
  const first = await f.store.put(putInput(f.store));
  await expectCode(
    f.store.put(putInput(f.store, { ordinal: 1, canonicalBytes: Buffer.from("beta\n") })),
    "ARTIFACT_ID_GENERATION_FAILED",
  );
  assert.equal((await readdir(f.paths.capturedArtifactObjectsDirectory)).length, 1);
  const metadata = evidenceMetadataFromReceipt(first);
  assert.equal(Object.hasOwn(metadata, "artifactRef"), false);
  assert.equal(Object.hasOwn(metadata, "binding"), false);
  assert.equal(Object.hasOwn(metadata, "bytes"), false);
  assert.equal(JSON.stringify(metadata).includes(ACTOR), false);
});
