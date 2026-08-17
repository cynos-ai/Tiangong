import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { sha256 } from "../canonical-json.mjs";
import { isChangeRevisionRef } from "../work/change-revision-ref.mjs";
import { FORBIDDEN_ENV_KEYS } from "./runner-policy.mjs";

const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const INVOCATION_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^run-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_ENV_KEYS = Object.freeze(["HOME", "PATH", "TIANGONG_RUN_ID"]);
const NEUTRALIZED_IMAGE_ENV_KEYS = Object.freeze([
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "OPENCLAW_AGENT_HARNESS_FALLBACK",
  "OPENCLAW_AGENT_RUNTIME",
  "OPENCLAW_CMS_PLUGIN_DIR",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  // Role identity belongs to the Worker control plane and must not leak into
  // a disposable command runner, which has no professional role authority.
  "TIANGONG_ROLE_ID",
  "TIANGONG_OTEL_EXPORTER_ENDPOINT",
  "http_proxy",
  "https_proxy",
]);

const OWNER = "tiangong-runner-port";
const MAX_FIXTURE_ENTRIES = 4096;
const MAX_FIXTURE_BYTES = 64 * 1024 * 1024;
const CONTROL_OUTPUT_LIMIT = 1024 * 1024;
const CONTROL_STDIN_LIMIT = 8 * 1024 * 1024;
const CAPTURE_MARKER = "TIANGONG_RUNNER_COMMAND_COMPLETE ";
const EXECUTION_MODES = new Set(["readonly-fixture", "capture-revision"]);

const CAPTURE_WRAPPER = String.raw`
import { chmod, cp, lstat, opendir, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
const revision = "/workspace/scratch/revision";
await cp("/workspace/fixture", revision, { recursive: true, force: false, errorOnExist: true });
async function makeWritable(directory) {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const entryPath = directory + "/" + entry.name;
    const metadata = await lstat(entryPath);
    if (metadata.isDirectory()) {
      await makeWritable(entryPath);
      await chmod(entryPath, 0o755);
    } else if (metadata.isFile()) {
      await chmod(entryPath, metadata.mode & 0o111 ? 0o755 : 0o644);
    } else {
      process.exit(126);
    }
  }
}
await makeWritable(revision);
await chmod(revision, 0o755);
const command = process.argv.slice(1);
let exitCode = 127;
try {
  const child = spawn(command[0], command.slice(1), {
    cwd: revision,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  exitCode = await new Promise((resolve) => {
    child.once("error", () => resolve(127));
    child.once("close", (code, signal) => resolve(signal ? 128 : (Number.isInteger(code) ? code : 127)));
  });
} catch {
  exitCode = 127;
}
let quietRounds = 0;
for (let round = 0; round < 100; round += 1) {
  const others = (await readdir("/proc"))
    .filter((entry) => /^\d+$/u.test(entry) && entry !== String(process.pid));
  quietRounds = others.length === 0 ? quietRounds + 1 : 0;
  if (quietRounds >= 3) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (quietRounds < 3) process.exit(125);
process.stdout.write("${CAPTURE_MARKER}" + JSON.stringify({ exitCode }) + "\n");
setInterval(() => {}, 60000);
`;

const SEED_SCRIPT = String.raw`
import { chmod, lstat, opendir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = "/workspace/fixture";
const entries = [];
let count = 0;
let bytes = 0;
async function walk(directory, prefix = "") {
  const handle = await opendir(directory);
  const children = [];
  for await (const entry of handle) children.push(entry);
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of children) {
    count += 1;
    if (count > 4096) throw new Error("fixture entry limit exceeded");
    const entryPath = directory + "/" + entry.name;
    const relativePath = prefix ? prefix + "/" + entry.name : entry.name;
    const stat = await lstat(entryPath);
    if (stat.isSymbolicLink()) throw new Error("fixture link rejected");
    if (stat.isDirectory()) {
      entries.push([relativePath, "directory"]);
      await walk(entryPath, relativePath);
      await chmod(entryPath, 0o555);
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) throw new Error("fixture hard link rejected");
      const content = await readFile(entryPath);
      bytes += content.length;
      if (bytes > 67108864) throw new Error("fixture byte limit exceeded");
      const executable = Boolean(stat.mode & 0o111);
      entries.push([
        relativePath,
        "file",
        content.length,
        createHash("sha256").update(content).digest("hex"),
        executable,
      ]);
      await chmod(entryPath, executable ? 0o555 : 0o444);
    } else {
      throw new Error("unsupported fixture entry");
    }
  }
}
await walk(root);
await chmod(root, 0o555);
entries.sort((left, right) => left[0].localeCompare(right[0]));
const digest = createHash("sha256");
for (const entry of entries) digest.update(JSON.stringify(entry) + "\n");
process.stdout.write(digest.digest("hex") + "\n");
`;

const FIXED_POLICY = Object.freeze({
  networkMode: "none",
  readOnlyRootFilesystem: true,
  capDrop: Object.freeze(["ALL"]),
  securityOpt: Object.freeze(["no-new-privileges"]),
  pidsLimit: 128,
  memoryBytes: 256 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  user: "65532:65532",
  tempTmpfs: "/tmp:rw,noexec,nosuid,nodev,size=16m",
  scratchTmpfs: "/workspace/scratch:rw,noexec,nosuid,nodev,size=64m,mode=0777",
  fixtureDestination: "/workspace/fixture",
  scratchDestination: "/workspace/scratch",
  neutralizedImageEnvKeys: NEUTRALIZED_IMAGE_ENV_KEYS,
});

function boundedAppend(chunks, chunk, state, limit) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (state.bytes >= limit) {
    if (bytes.length > 0) state.truncated = true;
    return;
  }
  const remaining = limit - state.bytes;
  const kept = bytes.subarray(0, remaining);
  if (kept.length > 0) chunks.push(kept);
  state.bytes += kept.length;
  if (kept.length !== bytes.length) state.truncated = true;
}

export function createDockerCommandRunner({
  dockerPath = "/usr/local/bin/docker",
  socketPath = "/var/run/docker.sock",
} = {}) {
  if (!path.isAbsolute(dockerPath) || !path.isAbsolute(socketPath)) {
    throw new Error("Docker executable and socket paths must be absolute");
  }
  return async function runDocker(args, { timeoutMs = 30_000, outputLimitBytes = CONTROL_OUTPUT_LIMIT, input } = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new TypeError("Docker arguments must be a string array");
    }
    if (input !== undefined && !Buffer.isBuffer(input) && typeof input !== "string") {
      throw new TypeError("Docker stdin must be a string or Buffer");
    }
    if (input !== undefined && Buffer.byteLength(input) > CONTROL_STDIN_LIMIT) {
      throw new Error("Docker stdin exceeded the bounded control limit");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(dockerPath, args, {
        env: {
          HOME: "/tmp",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          DOCKER_HOST: `unix://${socketPath}`,
        },
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      const stdoutState = { bytes: 0, truncated: false };
      const stderrState = { bytes: 0, truncated: false };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk) => boundedAppend(stdout, chunk, stdoutState, outputLimitBytes));
      child.stderr.on("data", (chunk) => boundedAppend(stderr, chunk, stderrState, outputLimitBytes));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode,
          signal,
          timedOut,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdoutTruncated: stdoutState.truncated,
          stderrTruncated: stderrState.truncated,
        });
      });
      if (input !== undefined) child.stdin.end(input);
    });
  };
}

export async function inspectRunnerFixture(fixtureSource) {
  if (typeof fixtureSource !== "string" || !path.isAbsolute(fixtureSource)) {
    throw new Error("fixtureSource must be an absolute directory");
  }
  const resolved = await realpath(fixtureSource);
  if (resolved !== fixtureSource) throw new Error("fixtureSource must not traverse a symbolic link");
  const root = await lstat(resolved);
  if (!root.isDirectory()) throw new Error("fixtureSource must be a directory");

  let count = 0;
  let bytes = 0;
  const manifest = [];
  async function walk(directory, prefix = "") {
    const handle = await opendir(directory);
    const children = [];
    for await (const entry of handle) children.push(entry);
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of children) {
      count += 1;
      if (count > MAX_FIXTURE_ENTRIES) throw new Error("runner fixture has too many entries");
      const entryPath = path.join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await lstat(entryPath);
      if (stat.isSymbolicLink()) throw new Error("runner fixture must not contain symbolic links");
      if (stat.isDirectory()) {
        manifest.push([relativePath, "directory"]);
        await walk(entryPath, relativePath);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error("runner fixture must not contain hard-linked files");
        const content = await readFile(entryPath);
        bytes += content.length;
        if (bytes > MAX_FIXTURE_BYTES) throw new Error("runner fixture exceeds the byte limit");
        manifest.push([
          relativePath,
          "file",
          content.length,
          createHash("sha256").update(content).digest("hex"),
          Boolean(stat.mode & 0o111),
        ]);
      } else {
        throw new Error("runner fixture contains an unsupported filesystem entry");
      }
    }
  }
  await walk(resolved);
  manifest.sort((left, right) => left[0].localeCompare(right[0]));
  const digest = createHash("sha256");
  for (const entry of manifest) digest.update(`${JSON.stringify(entry)}\n`);
  return Object.freeze({ source: resolved, digest: digest.digest("hex") });
}

function resourceIdentity(request) {
  const runMatch = RUN_ID_PATTERN.exec(request.runId);
  if (!runMatch || !INVOCATION_KEY_PATTERN.test(request.invocationKey)) {
    throw new Error("Docker executor requires validated run and invocation identities");
  }
  const suffix = `${runMatch[1]}-${request.invocationKey.slice(0, 16)}`;
  return Object.freeze({
    runnerContainer: `tiangong-runner-${suffix}`,
    seedContainer: `tiangong-runner-seed-${suffix}`,
    fixtureVolume: `tiangong-runner-fixture-${suffix}`,
  });
}

function labels(request, policyDigest, fixtureDigest) {
  return Object.freeze({
    "io.tiangong.owner": OWNER,
    "io.tiangong.run-id": request.runId,
    "io.tiangong.invocation-key": request.invocationKey,
    "io.tiangong.runner-policy-digest": policyDigest,
    "io.tiangong.fixture-digest": fixtureDigest,
  });
}

function labelArgs(values) {
  return Object.entries(values).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

function envArgs(env) {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => {
      if (
        !ENV_KEY_PATTERN.test(key) ||
        FORBIDDEN_ENV_KEYS.includes(key) ||
        RESERVED_ENV_KEYS.includes(key) ||
        NEUTRALIZED_IMAGE_ENV_KEYS.includes(key)
      ) {
        throw new Error(`Runner environment key is not allowed: ${key}`);
      }
      return ["--env", `${key}=${String(value)}`];
    });
}

async function requireSuccess(runDocker, args, options, code) {
  const result = await runDocker(args, options);
  if (result.timedOut || result.exitCode !== 0) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return result;
}

async function inspectOne(runDocker, kind, name) {
  const result = await runDocker([kind, "inspect", name], { outputLimitBytes: CONTROL_OUTPUT_LIMIT });
  if (result.timedOut) throw new Error(`RUNNER_${kind.toUpperCase()}_INSPECT_TIMEOUT`);
  if (result.exitCode !== 0) {
    if (/(?:No such (?:object|container|volume):|no such volume)/iu.test(result.stderr)) return null;
    throw new Error(`RUNNER_${kind.toUpperCase()}_INSPECT_FAILED`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`RUNNER_${kind.toUpperCase()}_INSPECT_INVALID`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`RUNNER_${kind.toUpperCase()}_INSPECT_INVALID`);
  }
  return parsed[0];
}

function assertLabels(actual, expected, resourceName) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) {
      throw new Error(`Refusing a runner resource without exact ownership: ${resourceName}`);
    }
  }
}

function envMap(values) {
  const result = {};
  for (const value of values ?? []) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error("RUNNER_DAEMON_ENV_INVALID");
    const key = value.slice(0, separator);
    if (Object.hasOwn(result, key)) throw new Error("RUNNER_DAEMON_ENV_INVALID");
    result[key] = value.slice(separator + 1);
  }
  return result;
}

function assertSeedConfiguration(inspect, { imageId, identity, expectedLabels }) {
  if (inspect?.Image !== imageId || inspect?.Name !== `/${identity.seedContainer}`) {
    throw new Error("RUNNER_SEED_IDENTITY_MISMATCH");
  }
  assertLabels(inspect.Config?.Labels, expectedLabels, identity.seedContainer);
  const host = inspect.HostConfig;
  if (
    JSON.stringify(inspect.Config?.Entrypoint) !== JSON.stringify(["/usr/bin/node"]) ||
    JSON.stringify(inspect.Config?.Cmd) !== JSON.stringify(["--input-type=module", "-e", SEED_SCRIPT]) ||
    host?.NetworkMode !== "none" || host?.ReadonlyRootfs !== true ||
    JSON.stringify(host?.CapDrop) !== JSON.stringify(["ALL"]) ||
    JSON.stringify(host?.CapAdd) !== JSON.stringify(["CAP_FOWNER"]) ||
    JSON.stringify(host?.SecurityOpt) !== JSON.stringify(["no-new-privileges"]) ||
    host?.Privileged !== false || host?.Binds !== null ||
    JSON.stringify(host?.Devices) !== "[]" || host?.DeviceRequests !== null
  ) {
    throw new Error("RUNNER_SEED_POLICY_MISMATCH");
  }
  const mounts = inspect.Mounts;
  if (!Array.isArray(mounts) || mounts.length !== 1) throw new Error("RUNNER_SEED_MOUNT_MISMATCH");
  const fixture = mounts[0];
  if (
    fixture?.Type !== "volume" || fixture?.Name !== identity.fixtureVolume ||
    fixture?.Destination !== FIXED_POLICY.fixtureDestination || fixture?.RW !== true
  ) {
    throw new Error("RUNNER_SEED_MOUNT_MISMATCH");
  }
}

function assertRunnerConfiguration(inspect, { imageId, identity, expectedLabels, request, executionMode }) {
  if (inspect?.Image !== imageId || inspect?.Name !== `/${identity.runnerContainer}`) {
    throw new Error("RUNNER_DAEMON_IDENTITY_MISMATCH");
  }
  assertLabels(inspect.Config?.Labels, expectedLabels, identity.runnerContainer);
  const expectedEntrypoint = executionMode === "capture-revision" ? ["/usr/bin/node"] : [request.command[0]];
  const expectedCommand = executionMode === "capture-revision"
    ? ["--input-type=module", "-e", CAPTURE_WRAPPER, "--", ...request.command]
    : request.command.slice(1);
  if (
    JSON.stringify(inspect.Config?.Entrypoint) !== JSON.stringify(expectedEntrypoint) ||
    JSON.stringify(inspect.Config?.Cmd) !== JSON.stringify(expectedCommand)
  ) {
    throw new Error("RUNNER_DAEMON_COMMAND_MISMATCH");
  }
  const actualEnv = envMap(inspect.Config?.Env);
  const expectedEnv = {
    HOME: "/tmp",
    PATH: "/usr/bin:/bin",
    TIANGONG_RUN_ID: request.runId,
    ...Object.fromEntries(NEUTRALIZED_IMAGE_ENV_KEYS.map((key) => [key, ""])),
    ...Object.fromEntries(Object.entries(request.env)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)])),
  };
  if (sha256(actualEnv) !== sha256(expectedEnv)) {
    throw new Error("RUNNER_DAEMON_ENV_MISMATCH");
  }
  const host = inspect.HostConfig;
  if (
    inspect.Config?.User !== FIXED_POLICY.user ||
    host?.NetworkMode !== FIXED_POLICY.networkMode ||
    host?.ReadonlyRootfs !== true ||
    JSON.stringify(host?.CapDrop) !== JSON.stringify(FIXED_POLICY.capDrop) ||
    host?.CapAdd !== null ||
    JSON.stringify(host?.SecurityOpt) !== JSON.stringify(FIXED_POLICY.securityOpt) ||
    host?.Privileged !== false ||
    host?.Binds !== null ||
    JSON.stringify(host?.Devices) !== "[]" ||
    host?.DeviceRequests !== null ||
    host?.PidMode !== "" || host?.IpcMode !== "private" || host?.UTSMode !== "" ||
    host?.UsernsMode !== "" || host?.CgroupnsMode !== "private" ||
    JSON.stringify(host?.PortBindings) !== "{}" || host?.PublishAllPorts !== false ||
    sha256(host?.Tmpfs) !== sha256({
      "/tmp": FIXED_POLICY.tempTmpfs.slice(FIXED_POLICY.tempTmpfs.indexOf(":") + 1),
      "/workspace/scratch": FIXED_POLICY.scratchTmpfs.slice(FIXED_POLICY.scratchTmpfs.indexOf(":") + 1),
    }) ||
    JSON.stringify(host?.RestartPolicy) !== JSON.stringify({ Name: "no", MaximumRetryCount: 0 }) ||
    host?.LogConfig?.Type !== "local" ||
    sha256(host?.LogConfig?.Config) !== sha256({ compress: "false", "max-file": "1", "max-size": "1m" }) ||
    host?.PidsLimit !== FIXED_POLICY.pidsLimit ||
    host?.Memory !== FIXED_POLICY.memoryBytes ||
    host?.NanoCpus !== FIXED_POLICY.nanoCpus
  ) {
    throw new Error("RUNNER_DAEMON_POLICY_MISMATCH");
  }
  const mounts = inspect.Mounts;
  if (!Array.isArray(mounts) || mounts.length !== 1) throw new Error("RUNNER_DAEMON_MOUNT_MISMATCH");
  const fixture = mounts[0];
  if (
    fixture?.Type !== "volume" || fixture?.Name !== identity.fixtureVolume ||
    fixture?.Destination !== FIXED_POLICY.fixtureDestination || fixture?.RW !== false
  ) {
    throw new Error("RUNNER_DAEMON_MOUNT_MISMATCH");
  }
  if (FORBIDDEN_ENV_KEYS.some((key) => Object.hasOwn(actualEnv, key))) {
    throw new Error("RUNNER_DAEMON_FORBIDDEN_ENV");
  }
  const expectedWorkingDirectory = executionMode === "capture-revision" ? "/workspace/fixture" : `/workspace/${request.cwd}`;
  if (inspect.Config?.WorkingDir !== expectedWorkingDirectory) {
    throw new Error("RUNNER_DAEMON_WORKDIR_MISMATCH");
  }
}

async function removeOwnedContainer(runDocker, name, expectedLabels) {
  const inspect = await inspectOne(runDocker, "container", name);
  if (!inspect) return;
  assertLabels(inspect.Config?.Labels, expectedLabels, name);
  await requireSuccess(runDocker, ["container", "rm", "--force", name], {}, "RUNNER_CONTAINER_CLEANUP_FAILED");
  if (await inspectOne(runDocker, "container", name)) {
    throw new Error("RUNNER_CONTAINER_CLEANUP_INCOMPLETE");
  }
}

async function removeOwnedVolume(runDocker, name, expectedLabels) {
  const inspect = await inspectOne(runDocker, "volume", name);
  if (!inspect) return;
  assertLabels(inspect.Labels, expectedLabels, name);
  await requireSuccess(runDocker, ["volume", "rm", name], {}, "RUNNER_VOLUME_CLEANUP_FAILED");
  if (await inspectOne(runDocker, "volume", name)) {
    throw new Error("RUNNER_VOLUME_CLEANUP_INCOMPLETE");
  }
}

function parseCaptureMarker(stdout) {
  const markers = stdout.split("\n").filter((line) => line.startsWith(CAPTURE_MARKER));
  if (markers.length === 0) return undefined;
  let value;
  try {
    value = JSON.parse(markers.at(-1).slice(CAPTURE_MARKER.length));
  } catch {
    throw new Error("RUNNER_CAPTURE_MARKER_INVALID");
  }
  if (!Number.isInteger(value?.exitCode) || value.exitCode < 0 || value.exitCode > 255) {
    throw new Error("RUNNER_CAPTURE_MARKER_INVALID");
  }
  return value.exitCode;
}

function withoutCaptureMarkers(stdout) {
  return stdout.split("\n").filter((line) => !line.startsWith(CAPTURE_MARKER)).join("\n");
}

async function runCaptureCommand(runDocker, containerName, request) {
  await requireSuccess(runDocker, ["container", "start", containerName], {}, "RUNNER_CONTAINER_START_FAILED");
  const deadline = Date.now() + request.timeoutMs;
  let lastProcessCount = -1;
  let markerObserved = false;
  while (Date.now() < deadline) {
    const inspected = await inspectOne(runDocker, "container", containerName);
    if (!inspected?.State?.Running) {
      process.stderr.write(`runner_capture_stopped exit=${Number.isInteger(inspected?.State?.ExitCode) ? inspected.State.ExitCode : "unknown"} oom=${inspected?.State?.OOMKilled === true}\n`);
      return { interrupted: true };
    }
    const [top, logs] = await Promise.all([
      runDocker(["container", "top", containerName, "-eo", "pid"], { outputLimitBytes: CONTROL_OUTPUT_LIMIT }),
      runDocker(["container", "logs", containerName], { outputLimitBytes: CONTROL_OUTPUT_LIMIT }),
    ]);
    if (top.timedOut || top.exitCode !== 0 || logs.timedOut || logs.exitCode !== 0) {
      throw new Error("RUNNER_CAPTURE_OBSERVATION_FAILED");
    }
    const processes = top.stdout.trim().split("\n").filter(Boolean);
    const exitCode = parseCaptureMarker(logs.stdout);
    lastProcessCount = processes.length;
    markerObserved ||= exitCode !== undefined;
    if (exitCode !== undefined && processes.length === 2) {
      return {
        interrupted: false,
        exitCode,
        stdout: withoutCaptureMarkers(logs.stdout),
        stderr: logs.stderr,
      };
    }
    await delay(25);
  }
  process.stderr.write(`runner_capture_timeout marker=${markerObserved} process_lines=${lastProcessCount}\n`);
  return { interrupted: true };
}

export function createDisposableDockerExecutor({
  imageId,
  fixtureSource,
  executionMode = "readonly-fixture",
  captureRevision,
  inputChangeRevisionRef,
  runDocker = createDockerCommandRunner(),
} = {}) {
  if (!IMAGE_ID_PATTERN.test(imageId)) {
    throw new Error("runner image must be an immutable sha256 image ID");
  }
  if (typeof runDocker !== "function") throw new TypeError("runDocker must be a function");
  if (!EXECUTION_MODES.has(executionMode) ||
      (executionMode === "capture-revision" && typeof captureRevision !== "function") ||
      (inputChangeRevisionRef !== undefined && !isChangeRevisionRef(inputChangeRevisionRef))) {
    throw new TypeError("Runner execution mode or ChangeRevision binding is invalid");
  }
  const policyDigest = sha256({ schemaVersion: 2, imageId, executionMode, policy: FIXED_POLICY });

  return async function execute(request) {
    const fixture = await inspectRunnerFixture(fixtureSource);
    if (inputChangeRevisionRef && fixture.digest !== inputChangeRevisionRef.artifactDigest) {
      throw new Error("Runner input ChangeRevision digest does not match its materialized fixture");
    }
    if ((executionMode === "capture-revision" && request.cwd !== "scratch/revision") ||
        (executionMode === "readonly-fixture" && request.cwd === "scratch/revision")) {
      throw new Error("Runner working directory is not authorized for its execution mode");
    }
    const identity = resourceIdentity(request);
    const expectedLabels = labels(request, policyDigest, fixture.digest);
    const startedAt = Date.now();
    let commandResult;
    let interrupted = false;
    let primaryError;

    try {
      for (const volume of [identity.fixtureVolume]) {
        const existing = await inspectOne(runDocker, "volume", volume);
        if (existing) throw new Error(`Refusing to replace existing runner volume: ${volume}`);
        await requireSuccess(
          runDocker,
          ["volume", "create", ...labelArgs(expectedLabels), volume],
          {},
          "RUNNER_VOLUME_CREATE_FAILED",
        );
        const created = await inspectOne(runDocker, "volume", volume);
        if (!created) throw new Error("RUNNER_VOLUME_CREATE_UNCONFIRMED");
        assertLabels(created.Labels, expectedLabels, volume);
      }

      await requireSuccess(
        runDocker,
        [
          "container", "create", "--name", identity.seedContainer,
          ...labelArgs(expectedLabels),
          "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "FOWNER",
          "--security-opt", "no-new-privileges",
          "--mount", `type=volume,src=${identity.fixtureVolume},dst=${FIXED_POLICY.fixtureDestination}`,
          "--entrypoint", "/usr/bin/node", imageId,
          "--input-type=module", "-e", SEED_SCRIPT,
        ],
        {},
        "RUNNER_SEED_CREATE_FAILED",
      );
      const seedConfig = await inspectOne(runDocker, "container", identity.seedContainer);
      assertSeedConfiguration(seedConfig, { imageId, identity, expectedLabels });
      await requireSuccess(
        runDocker,
        ["container", "cp", `${fixture.source}/.`, `${identity.seedContainer}:${FIXED_POLICY.fixtureDestination}/`],
        {},
        "RUNNER_FIXTURE_COPY_FAILED",
      );
      const seedResult = await requireSuccess(
        runDocker,
        ["container", "start", "--attach", identity.seedContainer],
        {},
        "RUNNER_SEED_FAILED",
      );
      if (seedResult.stdout.trim() !== fixture.digest) {
        throw new Error("RUNNER_FIXTURE_DIGEST_MISMATCH");
      }
      await removeOwnedContainer(runDocker, identity.seedContainer, expectedLabels);

      const runnerArgs = [
        "container", "create", "--name", identity.runnerContainer,
        ...labelArgs(expectedLabels),
        "--network", FIXED_POLICY.networkMode,
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", String(FIXED_POLICY.pidsLimit),
        "--memory", String(FIXED_POLICY.memoryBytes),
        "--cpus", "1",
        "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
        "--user", FIXED_POLICY.user,
        "--tmpfs", FIXED_POLICY.tempTmpfs,
        "--tmpfs", FIXED_POLICY.scratchTmpfs,
        "--mount", `type=volume,src=${identity.fixtureVolume},dst=${FIXED_POLICY.fixtureDestination},readonly`,
        "--workdir", executionMode === "capture-revision" ? "/workspace/fixture" : `/workspace/${request.cwd}`,
        "--env", "HOME=/tmp", "--env", "PATH=/usr/bin:/bin",
        "--env", `TIANGONG_RUN_ID=${request.runId}`,
        ...NEUTRALIZED_IMAGE_ENV_KEYS.flatMap((key) => ["--env", `${key}=`]),
        ...envArgs(request.env),
        "--entrypoint", executionMode === "capture-revision" ? "/usr/bin/node" : request.command[0], imageId,
        ...(executionMode === "capture-revision"
          ? ["--input-type=module", "-e", CAPTURE_WRAPPER, "--", ...request.command]
          : request.command.slice(1)),
      ];
      await requireSuccess(runDocker, runnerArgs, {}, "RUNNER_CONTAINER_CREATE_FAILED");
      const daemonConfig = await inspectOne(runDocker, "container", identity.runnerContainer);
      assertRunnerConfiguration(daemonConfig, { imageId, identity, expectedLabels, request, executionMode });
      const containerConfigDigest = sha256({
        imageId,
        policyDigest,
        executionMode,
        runId: request.runId,
        invocationKey: request.invocationKey,
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        fixtureDigest: fixture.digest,
      });

      if (executionMode === "capture-revision") {
        commandResult = await runCaptureCommand(runDocker, identity.runnerContainer, request);
        interrupted = commandResult.interrupted;
        if (!interrupted && commandResult.exitCode === 0) {
          commandResult.changeRevisionRef = await captureRevision({
            containerName: identity.runnerContainer,
            invocationKey: request.invocationKey,
          });
        }
      } else {
        commandResult = await runDocker(
          ["container", "start", "--attach", identity.runnerContainer],
          { timeoutMs: request.timeoutMs, outputLimitBytes: request.outputLimitBytes },
        );
        if (commandResult.timedOut || commandResult.signal) {
          interrupted = true;
        } else {
          const stopped = await inspectOne(runDocker, "container", identity.runnerContainer);
          if (!Number.isInteger(stopped?.State?.ExitCode)) throw new Error("RUNNER_EXIT_CODE_UNAVAILABLE");
          commandResult.exitCode = stopped.State.ExitCode;
        }
      }

      if (!interrupted) {
        commandResult.runnerEvidence = Object.freeze({
          schemaVersion: 1,
          runId: request.runId,
          invocationKey: request.invocationKey,
          imageId,
          policyDigest,
          containerConfigDigest,
          fixtureDigest: fixture.digest,
        });
        if (!commandResult.changeRevisionRef && inputChangeRevisionRef) {
          commandResult.changeRevisionRef = inputChangeRevisionRef;
        }
      }
    } catch (error) {
      primaryError = error;
    }

    let cleanupError;
    try {
      await removeOwnedContainer(runDocker, identity.runnerContainer, expectedLabels);
      await removeOwnedContainer(runDocker, identity.seedContainer, expectedLabels);
      await removeOwnedVolume(runDocker, identity.fixtureVolume, expectedLabels);
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError || cleanupError) {
      const error = new Error(cleanupError ? "RUNNER_CLEANUP_FAILED" : "RUNNER_EXECUTION_FAILED", {
        cause: cleanupError ?? primaryError,
      });
      error.code = cleanupError ? "RUNNER_CLEANUP_FAILED" : "RUNNER_EXECUTION_FAILED";
      throw error;
    }
    if (interrupted) return { status: "interrupted", exitCode: null };
    return {
      status: "completed",
      exitCode: commandResult.exitCode,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      durationMs: Date.now() - startedAt,
      runnerEvidence: commandResult.runnerEvidence,
      ...(commandResult.changeRevisionRef ? { changeRevisionRef: commandResult.changeRevisionRef } : {}),
    };
  };
}
