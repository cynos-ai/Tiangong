import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { CapturedArtifactStore } from "../agent/artifacts/store.mjs";
import { canonicalJson, sha256 } from "../agent/canonical-json.mjs";
import { loadRoleProfileBundle } from "../agent/config/role-profile.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { evidenceBoundary, projectReviewEvidence } from "../agent/evidence/projection.mjs";
import { ReviewerPracticeGate } from "../agent/gates/reviewer-practice-gate.mjs";
import { LocalGitExecutor } from "../agent/git/local-git-executor.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";
import { PracticeRunService } from "../agent/practices/practice-run-service.mjs";
import { projectReviewReadCoverage } from "../agent/practices/review-read-coverage.mjs";
import { createReviewerToolRegistry } from "../agent/work/reviewer-tools.mjs";

const WORKER_ROOT = new URL("..", import.meta.url).pathname;
const SESSION = "reviewer-local-git-session";
const ACTOR = "@reviewer:example.test";

function git(repository, ...args) {
  return execFileSync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C", LANG: "C" },
  }).trim();
}

function directExecutor(f, overrides = {}) {
  const sessionHash = sha256(f.workspaceDir);
  return new LocalGitExecutor({
    workspaceDir: f.workspaceDir,
    sessionHash,
    lockPath: join(f.stateDirectory, "local-git", sessionHash, "lock-target"),
    expectedVersionOutput: `${execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).trim()}\n`,
    gitExecPath: execFileSync("/usr/bin/git", ["--exec-path"], { encoding: "utf8" }).trim(),
    tempRoot: join(dirname(f.workspaceDir), "local-git-tmp"),
    ...overrides,
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

async function treeDigest(root) {
  const entries = [];
  const walk = async (directory) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const value = await stat(path);
      const key = relative(root, path);
      if (value.isDirectory()) {
        entries.push({ path: key, kind: "directory", mode: value.mode & 0o7777 });
        await walk(path);
      } else {
        entries.push({
          path: key,
          kind: "file",
          mode: value.mode & 0o7777,
          bytes: (await readFile(path)).toString("base64"),
        });
      }
    }
  };
  await walk(root);
  return sha256(canonicalJson(entries));
}

async function fixture(t, { objectFormat = "sha1", annotatedTag = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-local-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(join(workspaceDir, "src"), { recursive: true });
  git(workspaceDir, "init", "--quiet", `--object-format=${objectFormat}`);
  git(workspaceDir, "config", "user.name", "Fixture");
  git(workspaceDir, "config", "user.email", "fixture@example.test");
  await writeFile(join(workspaceDir, "src", "one.txt"), "one\n");
  git(workspaceDir, "add", ".");
  git(workspaceDir, "commit", "--quiet", "-m", "base");
  const baseOid = git(workspaceDir, "rev-parse", "HEAD");
  await writeFile(join(workspaceDir, "src", "one.txt"), "two\n");
  await writeFile(join(workspaceDir, "src", "two.txt"), "second\n");
  git(workspaceDir, "add", ".");
  git(workspaceDir, "commit", "--quiet", "-m", "head");
  const headOid = git(workspaceDir, "rev-parse", "HEAD");
  if (annotatedTag) git(workspaceDir, "tag", "-a", "review-target", "-m", "review target");
  git(workspaceDir, "gc", "--prune=now");
  const sourceDigest = await treeDigest(workspaceDir);

  const profileBundle = await loadRoleProfileBundle({
    profilePath: join(WORKER_ROOT, "role-profiles", "reviewer.json"),
    resourceRoot: WORKER_ROOT,
  });
  const paths = statePathsForSession({ stateDirectory, sessionId: SESSION });
  const artifactStore = new CapturedArtifactStore({ stateDirectory, sessionId: SESSION });
  const launches = [];
  const serviceOptions = {
    sessionId: SESSION,
    workspaceDir,
    profileBundle,
    journalPath: paths.practiceRunJournalPath,
    snapshotPath: paths.practiceRunSnapshotPath,
    protectedDirectory: paths.practiceRunProtectedDirectory,
    artifactStore,
    localGitLockPath: paths.localGitLockPath,
    localGitOptions: {
      expectedVersionOutput: `${execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).trim()}\n`,
      gitExecPath: execFileSync("/usr/bin/git", ["--exec-path"], { encoding: "utf8" }).trim(),
      execFile(file, args, options) {
        launches.push({ file, args: [...args], options: { ...options, env: { ...options.env } } });
        return execFile(file, args, options);
      },
    },
  };
  const service = new PracticeRunService(serviceOptions);
  const evidence = new EvidenceRecorder({ filePath: paths.evidenceFilePath });
  const gate = new ReviewerPracticeGate({ profileBundle });
  let current;
  const registry = createReviewerToolRegistry({
    service,
    gate,
    evidence,
    getInvocation: () => current,
    inspectionLockPath: paths.reviewInspectionLockPath,
  });
  const tool = (name) => registry.definitions().find((entry) => entry.name === name);
  const begin = (turnId) => {
    current = {
      sessionId: SESSION,
      turnId,
      actor: { id: ACTOR, messageId: `message-${turnId}` },
      ingress: { prompt: "review the pinned local Git targets" },
      profileDigest: profileBundle.profileDigest,
      turnState: { decisionFor() { return undefined; } },
    };
  };
  return {
    workspaceDir, sourceDigest, stateDirectory, paths, service, serviceOptions, profileBundle,
    evidence, artifactStore,
    baseOid, headOid, annotatedTagRef: annotatedTag ? "refs/tags/review-target" : null,
    registry, tool, begin, launches,
  };
}

test("Reviewer local Git commit and direct diff targets are pinned, inspectable, consumable, and non-mutating", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.registry.names(), [
    "start_work", "extend_scope", "read", "inspect_directory", "inspect_repository", "check_completion", "abandon_work",
  ]);

  f.begin("start");
  const started = await f.tool("start_work").execute("call-start", {
    practiceId: "review",
    objective: "Review the pinned commit and direct diff",
    acceptanceCriteria: ["Consume every immutable Git resource"],
    targets: [
      { kind: "commit", repositoryPath: ".", ref: f.headOid, pathPrefixes: ["src"] },
      {
        kind: "git_diff",
        repositoryPath: ".",
        baseRef: f.baseOid,
        headRef: f.headOid,
        pathPrefixes: ["src"],
      },
    ],
  });
  assert.equal(f.launches.length, 27);
  for (const launch of f.launches) {
    assert.equal(launch.file, "/usr/bin/prlimit");
    assert.deepEqual(launch.args.slice(0, 7), [
      "--as=268435456", "--core=0", "--cpu=65", "--fsize=0", "--nofile=64", "--", "/usr/bin/git",
    ]);
    assert.match(
      launch.options.cwd,
      /^\/tmp\/tiangong-local-git\/[a-f0-9]{64}\/git-op-[a-f0-9]{64}-[0-9a-f-]{36}$/u,
    );
    assert.equal(launch.options.shell, false);
    assert.deepEqual(Object.keys(launch.options.env).sort(), [
      "GIT_ASKPASS", "GIT_ATTR_NOSYSTEM", "GIT_CEILING_DIRECTORIES", "GIT_CONFIG_COUNT",
      "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_DIR", "GIT_EDITOR",
      "GIT_EXEC_PATH", "GIT_LITERAL_PATHSPECS", "GIT_NO_REPLACE_OBJECTS", "GIT_OBJECT_DIRECTORY",
      "GIT_OPTIONAL_LOCKS", "GIT_PAGER", "GIT_SEQUENCE_EDITOR", "GIT_TERMINAL_PROMPT", "HOME",
      "LANG", "LC_ALL", "PAGER", "PATH", "SSH_ASKPASS", "TZ", "XDG_CONFIG_HOME",
    ].filter((key) => key !== "GIT_OBJECT_DIRECTORY" || Object.hasOwn(launch.options.env, key)).sort());
    assert.equal(launch.options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(launch.options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(launch.options.env.GIT_OBJECT_DIRECTORY?.startsWith("/tmp/tiangong-local-git/") ?? true, true);
    assert.equal(Object.keys(launch.options.env).some((key) => /PROXY|TOKEN|CREDENTIAL/u.test(key)), false);
    assert.equal(launch.args.some((argument) => argument === f.workspaceDir || argument.startsWith(`${f.workspaceDir}/`)), false);
  }
  const [commitRef, diffRef] = started.details.scopeTargets;
  assert.equal(commitRef.kind, "commit");
  assert.equal(diffRef.kind, "git_diff");
  const run = await f.service.activeForActor(ACTOR);
  assert.equal(run.scope.targets[0].snapshot.facts.commitOid, f.headOid);
  assert.equal(run.scope.targets[1].snapshot.facts.baseCommitOid, f.baseOid);
  assert.equal(run.scope.targets[1].snapshot.facts.headCommitOid, f.headOid);
  assert.equal(run.scope.targets[0].snapshot.facts.gitVersion, "2.43.0");
  assert.equal(run.scope.targets[1].snapshot.facts.changedFileCount, 2);

  f.begin("list");
  const listed = await f.tool("inspect_repository").execute("call-list", {
    targetId: commitRef.targetId,
    action: "list_commit",
    prefix: "src",
    offset: 0,
    limit: 200,
  });
  const list = JSON.parse(listed.content[0].text);
  assert.deepEqual(list.members.map((member) => member.path), ["src/one.txt", "src/two.txt"]);

  let projected = await projectReviewEvidence({
    evidence: f.evidence,
    boundary: await evidenceBoundary(f.evidence),
    run,
    targetCapture: f.service.targetCapture,
    artifactStore: f.artifactStore,
  });
  assert.deepEqual(projectReviewReadCoverage(run, projected).targets.map((entry) => entry.status), ["unread", "unread"]);

  for (const [index, memberPath] of list.members.map((member) => member.path).entries()) {
    f.begin(`commit-read-${index}`);
    await f.tool("read").execute(`call-commit-read-${index}`, {
      targetId: commitRef.targetId,
      memberPath,
      offset: 1,
      limit: 2000,
    });
  }
  assert.equal(f.launches.length, 49);
  f.begin("diff-read");
  const diff = await f.tool("read").execute("call-diff-read", {
    targetId: diffRef.targetId,
    offset: 1,
    limit: 2000,
  });
  assert.match(diff.content[0].text, /^diff --git a\/src\/one\.txt b\/src\/one\.txt/mu);
  assert.match(diff.content[0].text, /^diff --git a\/src\/two\.txt b\/src\/two\.txt/mu);
  assert.equal(f.launches.length, 49, "git_diff consume must use the journal-authorized admission artifact");

  projected = await projectReviewEvidence({
    evidence: f.evidence,
    boundary: await evidenceBoundary(f.evidence),
    run,
    targetCapture: f.service.targetCapture,
    artifactStore: f.artifactStore,
  });
  const coverage = projectReviewReadCoverage(run, projected);
  assert.equal(coverage.satisfied, true);
  assert.deepEqual(coverage.targets.map((entry) => entry.status), ["complete", "complete"]);
  assert.equal(projected.executions.filter((entry) => entry.toolName === "inspect_repository").length, 1);
  assert.equal(await treeDigest(f.workspaceDir), f.sourceDigest);

  await rm(join(f.workspaceDir, ".git"), { recursive: true, force: true });
  const restartedArtifactStore = new CapturedArtifactStore({ stateDirectory: f.stateDirectory, sessionId: SESSION });
  const restartedService = new PracticeRunService({
    ...f.serviceOptions,
    artifactStore: restartedArtifactStore,
  });
  const restartedEvidence = new EvidenceRecorder({ filePath: f.paths.evidenceFilePath });
  const restartedGate = new ReviewerPracticeGate({ profileBundle: f.profileBundle });
  let restartedCurrent;
  const restartedRegistry = createReviewerToolRegistry({
    service: restartedService,
    gate: restartedGate,
    evidence: restartedEvidence,
    getInvocation: () => restartedCurrent,
    inspectionLockPath: f.paths.reviewInspectionLockPath,
  });
  const restartedTool = (name) => restartedRegistry.definitions().find((entry) => entry.name === name);
  const restartBegin = (turnId) => {
    restartedCurrent = {
      sessionId: SESSION,
      turnId,
      actor: { id: ACTOR, messageId: `message-${turnId}` },
      ingress: { prompt: "review the pinned local Git targets" },
      profileDigest: f.profileBundle.profileDigest,
      turnState: { decisionFor() { return undefined; } },
    };
  };
  restartBegin("commit-read-0");
  const replayedCommit = await restartedTool("read").execute("call-commit-read-0", {
    targetId: commitRef.targetId,
    memberPath: "src/one.txt",
    offset: 1,
    limit: 2000,
  });
  assert.equal(replayedCommit.content[0].text, "two\n");
  restartBegin("diff-read");
  const replayedDiff = await restartedTool("read").execute("call-diff-read", {
    targetId: diffRef.targetId,
    offset: 1,
    limit: 2000,
  });
  assert.equal(replayedDiff.content[0].text, diff.content[0].text);
  restartBegin("list");
  const replayedList = await restartedTool("inspect_repository").execute("call-list", {
    targetId: commitRef.targetId,
    action: "list_commit",
    prefix: "src",
    offset: 0,
    limit: 200,
  });
  assert.equal(replayedList.content[0].text, listed.content[0].text);
  assert.equal(f.launches.length, 49, "successful replay must not access the removed source repository");

  const journal = await readFile(f.paths.practiceRunJournalPath, "utf8");
  const evidence = await readFile(f.paths.evidenceFilePath, "utf8");
  assert.doesNotMatch(evidence, /src\/one\.txt|src\/two\.txt|artifact-v1\/|diff --git/u);
  assert.equal(evidence.includes(f.baseOid), false);
  assert.equal(evidence.includes(f.headOid), false);
  assert.doesNotMatch(evidence, /"pathPrefixes"|"baseRef"|"headRef"|"ref":"/u);
  assert.doesNotMatch(journal, /"members"|diff --git/u);
});

test("SHA-256 packed repositories and annotated tags retain exact commit/diff authority", async (t) => {
  const f = await fixture(t, { objectFormat: "sha256", annotatedTag: true });
  f.begin("start-sha256");
  const started = await f.tool("start_work").execute("call-start-sha256", {
    practiceId: "review",
    objective: "Review one SHA-256 tagged commit and direct diff",
    acceptanceCriteria: ["Consume every selected immutable resource"],
    targets: [
      { kind: "commit", repositoryPath: ".", ref: f.annotatedTagRef, pathPrefixes: ["src"] },
      {
        kind: "git_diff", repositoryPath: ".", baseRef: f.baseOid, headRef: f.headOid,
        pathPrefixes: ["src"],
      },
    ],
  });
  const [commitRef, diffRef] = started.details.scopeTargets;
  const run = await f.service.activeForActor(ACTOR);
  assert.equal(run.scope.targets[0].snapshot.facts.objectFormat, "sha256");
  assert.equal(run.scope.targets[0].snapshot.facts.commitOid, f.headOid);
  assert.equal(run.scope.targets[0].snapshot.facts.commitOid.length, 64);
  assert.equal(run.scope.targets[1].snapshot.facts.baseCommitOid, f.baseOid);
  assert.equal(run.scope.targets[1].snapshot.facts.headCommitOid, f.headOid);

  f.begin("list-sha256");
  const listed = await f.tool("inspect_repository").execute("call-list-sha256", {
    targetId: commitRef.targetId,
    action: "list_commit",
    prefix: "src",
    offset: 0,
    limit: 200,
  });
  const members = JSON.parse(listed.content[0].text).members;
  for (const [index, member] of members.entries()) {
    f.begin(`read-sha256-${index}`);
    await f.tool("read").execute(`call-read-sha256-${index}`, {
      targetId: commitRef.targetId,
      memberPath: member.path,
      offset: 1,
      limit: 2000,
    });
  }
  f.begin("diff-sha256");
  await f.tool("read").execute("call-diff-sha256", {
    targetId: diffRef.targetId,
    offset: 1,
    limit: 2000,
  });
  const projected = await projectReviewEvidence({
    evidence: f.evidence,
    boundary: await evidenceBoundary(f.evidence),
    run,
    targetCapture: f.service.targetCapture,
    artifactStore: f.artifactStore,
  });
  assert.equal(projectReviewReadCoverage(run, projected).satisfied, true);
  assert.equal(await treeDigest(f.workspaceDir), f.sourceDigest);
});

test("local Git source and runtime boundary rejects unsafe adjacent repositories", async (t) => {
  await t.test("ordinary loose branch ref", async (t) => {
    const f = await fixture(t);
    git(f.workspaceDir, "update-ref", "refs/heads/loose-review", f.headOid);
    const captured = await directExecutor(f).captureCommit({
      repositoryPath: ".", ref: "refs/heads/loose-review", pathPrefixes: ["src"],
    });
    assert.equal(captured.facts.commitOid, f.headOid);
  });

  await t.test("packed ref cannot gain a higher-priority loose ref during capture", async (t) => {
    const f = await fixture(t);
    const branch = git(f.workspaceDir, "symbolic-ref", "HEAD");
    let injected = false;
    await expectCode(directExecutor(f, {
      execFile(file, args, options) {
        const child = execFile(file, args, options);
        if (args.includes("cat-file")) {
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = (...writeArgs) => {
            if (!injected) {
              injected = true;
              const refPath = join(f.workspaceDir, ".git", ...branch.split("/"));
              mkdirSync(dirname(refPath), { recursive: true });
              writeFileSync(refPath, `${f.baseOid}\n`, { mode: 0o600 });
            }
            return write(...writeArgs);
          };
        }
        return child;
      },
    }).captureCommit({
      repositoryPath: ".", ref: branch, pathPrefixes: ["src"],
    }), "TARGET_CHANGED_DURING_CAPTURE");
  });

  await t.test("repository ancestor cannot become a symlink during capture", async (t) => {
    const f = await fixture(t);
    const nested = join(f.workspaceDir, "nested");
    await mkdir(nested);
    git(nested, "init", "--quiet");
    git(nested, "config", "user.name", "Fixture");
    git(nested, "config", "user.email", "fixture@example.test");
    await writeFile(join(nested, "one.txt"), "nested\n");
    git(nested, "add", "one.txt");
    git(nested, "commit", "--quiet", "-m", "nested");
    const nestedOid = git(nested, "rev-parse", "HEAD");
    git(nested, "gc", "--prune=now");
    let injected = false;
    await expectCode(directExecutor(f, {
      execFile(file, args, options) {
        if (!injected && args.includes("cat-file")) {
          injected = true;
          renameSync(nested, join(f.workspaceDir, "nested-moved"));
          symlinkSync("nested-moved", nested);
        }
        return execFile(file, args, options);
      },
    }).captureCommit({
      repositoryPath: "nested", ref: nestedOid, pathPrefixes: ["."],
    }), "TARGET_CHANGED_DURING_CAPTURE");
  });

  await t.test("UTF-8 BOM in packed refs is not stripped", async (t) => {
    const f = await fixture(t);
    const packedPath = join(f.workspaceDir, ".git", "packed-refs");
    await writeFile(packedPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(packedPath)]));
    await expectCode(directExecutor(f).captureCommit({
      repositoryPath: ".", ref: f.headOid, pathPrefixes: ["src"],
    }), "GIT_REPOSITORY_UNSUPPORTED");
  });

  await t.test("non-ASCII HEAD bytes", async (t) => {
    const f = await fixture(t);
    const malformed = Buffer.from(`${"a".repeat(40)}\n`, "ascii");
    malformed[0] |= 0x80;
    await writeFile(join(f.workspaceDir, ".git", "HEAD"), malformed);
    await expectCode(directExecutor(f).captureCommit({
      repositoryPath: ".", ref: f.headOid, pathPrefixes: ["src"],
    }), "GIT_REPOSITORY_UNSUPPORTED");
  });

  await t.test("exit-zero short object frame", async (t) => {
    const f = await fixture(t);
    await expectCode(directExecutor(f, {
      execFile(file, args, options) {
        if (args.includes("cat-file")) {
          return execFile(process.execPath, [
            "-e",
            "process.stdin.once('data', b => { const o = /contents ([a-f0-9]+)/.exec(b.toString())[1]; process.stdout.write(o + ' commit 10\\nshort', () => process.exit(0)); });",
          ], options);
        }
        return execFile(file, args, options);
      },
    }).captureCommit({
      repositoryPath: ".", ref: f.headOid, pathPrefixes: ["src"],
    }), "TARGET_ARTIFACT_INVALID");
  });

  await t.test("duplicate blob/tree names in a raw tree", async (t) => {
    const f = await fixture(t);
    const environment = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C", LANG: "C" };
    const blobOid = execFileSync("/usr/bin/git", ["-C", f.workspaceDir, "hash-object", "-w", "--stdin"], {
      input: "duplicate\n", encoding: "utf8", env: environment,
    }).trim();
    const emptyTreeOid = execFileSync("/usr/bin/git", ["-C", f.workspaceDir, "mktree"], {
      input: "", encoding: "utf8", env: environment,
    }).trim();
    const rawTree = Buffer.concat([
      Buffer.from("100644 foo\0", "ascii"), Buffer.from(blobOid, "hex"),
      Buffer.from("40000 foo\0", "ascii"), Buffer.from(emptyTreeOid, "hex"),
    ]);
    const treeOid = execFileSync("/usr/bin/git", [
      "-C", f.workspaceDir, "hash-object", "-t", "tree", "--literally", "-w", "--stdin",
    ], { input: rawTree, encoding: "utf8", env: environment }).trim();
    const commitOid = git(f.workspaceDir, "commit-tree", treeOid, "-m", "duplicate tree names");
    await expectCode(directExecutor(f).captureCommit({
      repositoryPath: ".", ref: commitOid, pathPrefixes: ["."],
    }), "TARGET_ARTIFACT_INVALID");
  });

  await t.test("wrong runtime version", async (t) => {
    const f = await fixture(t);
    await expectCode(directExecutor(f, { expectedVersionOutput: "git version 0.0.0\n" }).captureCommit({
      repositoryPath: ".", ref: f.headOid, pathPrefixes: ["src"],
    }), "GIT_RUNTIME_UNAVAILABLE");
  });

  await t.test("alternate object storage", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.workspaceDir, ".git", "objects", "info"), { recursive: true });
    await writeFile(join(f.workspaceDir, ".git", "objects", "info", "alternates"), "/tmp/untrusted\n");
    await expectCode(directExecutor(f).captureCommit({
      repositoryPath: ".", ref: f.headOid, pathPrefixes: ["src"],
    }), "GIT_REPOSITORY_UNSUPPORTED");
  });

  await t.test("replace-ref namespace", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.workspaceDir, ".git", "refs", "replace"));
    await expectCode(directExecutor(f).captureCommit({
      repositoryPath: ".", ref: f.headOid, pathPrefixes: ["src"],
    }), "GIT_REPOSITORY_UNSUPPORTED");
  });

  await t.test("unknown repository extension", async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.workspaceDir, ".git", "config"), [
      "[core]", "\trepositoryformatversion = 0", "\tbare = false", "[extensions]", "\tunknown = true", "",
    ].join("\n"));
    await expectCode(directExecutor(f).captureCommit({
      repositoryPath: ".", ref: f.headOid, pathPrefixes: ["src"],
    }), "GIT_REPOSITORY_UNSUPPORTED");
  });

  await t.test("symlinked direct Git directory", async (t) => {
    const f = await fixture(t);
    const moved = join(f.workspaceDir, ".git-moved");
    await rename(join(f.workspaceDir, ".git"), moved);
    await symlink(moved, join(f.workspaceDir, ".git"));
    await expectCode(directExecutor(f).captureCommit({
      repositoryPath: ".", ref: f.headOid, pathPrefixes: ["src"],
    }), "TARGET_SYMLINK_DENIED");
  });

  await t.test("annotated tag depth overflow", async (t) => {
    const f = await fixture(t);
    let target = f.headOid;
    for (let index = 0; index < 9; index += 1) {
      const name = `nested-${index}`;
      git(f.workspaceDir, "-c", "advice.nestedTag=false", "tag", "-a", name, target, "-m", name);
      target = `refs/tags/${name}`;
    }
    await expectCode(directExecutor(f).captureCommit({
      repositoryPath: ".", ref: target, pathPrefixes: ["src"],
    }), "GIT_OBJECT_UNAVAILABLE");
  });
});
