import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDisposableDockerExecutor } from "../agent/runner/docker-executor.mjs";
import { runCommand } from "../agent/runner/runner-port.mjs";

const RUN_ID = "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function labelsFrom(args) {
  return Object.fromEntries(options(args, "--label").map((value) => {
    const separator = value.indexOf("=");
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

function tmpfsFrom(args) {
  return Object.fromEntries(options(args, "--tmpfs").map((value) => {
    const separator = value.indexOf(":");
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

function mountFrom(value) {
  const fields = value.split(",");
  const entries = Object.fromEntries(fields.filter((field) => field.includes("=")).map((field) => {
    const separator = field.indexOf("=");
    return [field.slice(0, separator), field.slice(separator + 1)];
  }));
  return {
    Type: entries.type,
    Name: entries.src,
    Destination: entries.dst,
    RW: !fields.includes("readonly"),
  };
}

function successfulDockerFake({ mutateRunner } = {}) {
  const volumes = new Map();
  const containers = new Map();
  const calls = [];
  const result = (overrides = {}) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    ...overrides,
  });

  const runDocker = async (args) => {
    calls.push([...args]);
    const [kind, action] = args;
    if (kind === "volume" && action === "inspect") {
      const volume = volumes.get(args[2]);
      return volume
        ? result({ stdout: JSON.stringify([volume]) })
        : result({ exitCode: 1, stderr: `Error: No such volume: ${args[2]}\n` });
    }
    if (kind === "volume" && action === "create") {
      const name = args.at(-1);
      volumes.set(name, { Name: name, Labels: labelsFrom(args) });
      return result({ stdout: `${name}\n` });
    }
    if (kind === "volume" && action === "rm") {
      volumes.delete(args[2]);
      return result();
    }
    if (kind === "container" && action === "inspect") {
      const container = containers.get(args[2]);
      return container
        ? result({ stdout: JSON.stringify([container]) })
        : result({ exitCode: 1, stderr: `Error: No such object: ${args[2]}\n` });
    }
    if (kind === "container" && action === "create") {
      const name = option(args, "--name");
      const isSeed = name.includes("-seed-");
      const imageIndex = args.indexOf(IMAGE_ID);
      const container = {
        Name: `/${name}`,
        Image: IMAGE_ID,
        Config: {
          User: option(args, "--user") ?? "",
          Labels: labelsFrom(args),
          Env: options(args, "--env"),
          WorkingDir: option(args, "--workdir") ?? "",
          Entrypoint: [option(args, "--entrypoint")],
          Cmd: args.slice(imageIndex + 1),
        },
        HostConfig: {
          NetworkMode: option(args, "--network"),
          ReadonlyRootfs: args.includes("--read-only"),
          CapDrop: options(args, "--cap-drop"),
          CapAdd: options(args, "--cap-add").length > 0
            ? options(args, "--cap-add").map((value) => `CAP_${value}`)
            : null,
          SecurityOpt: options(args, "--security-opt"),
          Privileged: false,
          Binds: null,
          Devices: [],
          DeviceRequests: null,
          PidMode: "",
          IpcMode: "private",
          UTSMode: "",
          UsernsMode: "",
          CgroupnsMode: "private",
          PortBindings: {},
          PublishAllPorts: false,
          Tmpfs: tmpfsFrom(args),
          RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
          PidsLimit: Number(option(args, "--pids-limit") ?? 0),
          Memory: Number(option(args, "--memory") ?? 0),
          NanoCpus: option(args, "--cpus") === "1" ? 1_000_000_000 : 0,
        },
        Mounts: options(args, "--mount").map(mountFrom),
        State: { ExitCode: isSeed ? 0 : 7 },
        command: args.slice(imageIndex + 1),
      };
      if (!isSeed) mutateRunner?.(container);
      containers.set(name, container);
      return result({ stdout: `${name}\n` });
    }
    if (kind === "container" && action === "cp") return result();
    if (kind === "container" && action === "start") {
      const name = args.at(-1);
      return result(name.includes("-seed-")
        ? { stdout: `${containers.get(name).Config.Labels["io.tiangong.fixture-digest"]}\n` }
        : { stdout: "bounded output\n" });
    }
    if (kind === "container" && action === "rm") {
      containers.delete(args.at(-1));
      return result();
    }
    throw new Error(`unexpected Docker call: ${args.join(" ")}`);
  };
  return { runDocker, calls, containers, volumes };
}

async function withFixture(task) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tiangong-docker-executor-test-"));
  try {
    await writeFile(path.join(directory, "input.txt"), "fixture\n", { mode: 0o600 });
    return await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("disposable Docker executor uses the immutable image and exact isolation policy", async () => {
  await withFixture(async (fixtureSource) => {
    const fake = successfulDockerFake();
    const executor = createDisposableDockerExecutor({
      imageId: IMAGE_ID,
      fixtureSource,
      runDocker: fake.runDocker,
    });
    const response = await runCommand({
      runId: RUN_ID,
      command: ["node", "-e", "process.exit(7)"],
      cwd: "fixture",
      timeoutMs: 1000,
      outputLimitBytes: 1024,
    }, { executor, env: { NODE_ENV: "test" } });

    assert.equal(response.outcome, "completed");
    assert.equal(response.exitCode, 7);
    assert.equal(response.stdout, "bounded output\n");
    assert.equal(response.runnerEvidence.imageId, IMAGE_ID);
    assert.match(response.runnerEvidence.policyDigest, /^[0-9a-f]{64}$/u);
    assert.match(response.runnerEvidence.containerConfigDigest, /^[0-9a-f]{64}$/u);
    assert.match(response.runnerEvidence.fixtureDigest, /^[0-9a-f]{64}$/u);
    assert.equal(fake.containers.size, 0);
    assert.equal(fake.volumes.size, 0);

    const runnerCreate = fake.calls.find((args) =>
      args[0] === "container" && args[1] === "create" && !option(args, "--name").includes("-seed-"));
    assert.ok(runnerCreate);
    assert.equal(option(runnerCreate, "--network"), "none");
    assert.equal(option(runnerCreate, "--user"), "65532:65532");
    assert.equal(option(runnerCreate, "--pids-limit"), "128");
    assert.equal(option(runnerCreate, "--memory"), String(256 * 1024 * 1024));
    assert.ok(runnerCreate.includes("--read-only"));
    assert.deepEqual(options(runnerCreate, "--cap-drop"), ["ALL"]);
    assert.deepEqual(options(runnerCreate, "--security-opt"), ["no-new-privileges"]);
    assert.deepEqual(options(runnerCreate, "--mount").map(mountFrom), [{
      Type: "volume",
      Name: option(runnerCreate, "--mount").split(",")[1].slice(4),
      Destination: "/workspace/fixture",
      RW: false,
    }]);
    assert.equal(tmpfsFrom(runnerCreate)["/workspace/scratch"], "rw,noexec,nosuid,nodev,size=64m,mode=0777");
    assert.ok(options(runnerCreate, "--env").includes("NODE_ENV=test"));
  });
});

test("disposable Docker executor refuses a daemon policy mismatch before command start", async () => {
  await withFixture(async (fixtureSource) => {
    const fake = successfulDockerFake({
      mutateRunner: (container) => {
        container.HostConfig.NetworkMode = "agentteams-net";
      },
    });
    const executor = createDisposableDockerExecutor({
      imageId: IMAGE_ID,
      fixtureSource,
      runDocker: fake.runDocker,
    });
    const response = await runCommand({
      runId: RUN_ID,
      command: ["node", "-e", "1"],
      cwd: "fixture",
      timeoutMs: 1000,
    }, { executor, env: {} });
    assert.equal(response.outcome, "outcome_uncertain");
    assert.equal(fake.calls.some((args) =>
      args[0] === "container" && args[1] === "start" && !args.at(-1).includes("-seed-")), false);
    assert.equal(fake.containers.size, 0);
    assert.equal(fake.volumes.size, 0);
  });
});

test("disposable Docker executor neutralizes image defaults and rejects an unexpected daemon env", async () => {
  await withFixture(async (fixtureSource) => {
    const fake = successfulDockerFake({
      mutateRunner: (container) => {
        container.Config.Env.push("UNEXPECTED_IMAGE_ENV=value");
      },
    });
    const executor = createDisposableDockerExecutor({
      imageId: IMAGE_ID,
      fixtureSource,
      runDocker: fake.runDocker,
    });
    const response = await runCommand({
      runId: RUN_ID,
      command: ["node", "-e", "1"],
      cwd: "fixture",
      timeoutMs: 1000,
    }, { executor, env: {} });
    assert.equal(response.outcome, "outcome_uncertain");
    assert.equal(fake.calls.some((args) =>
      args[0] === "container" && args[1] === "start" && !args.at(-1).includes("-seed-")), false);
    assert.equal(fake.containers.size, 0);
    assert.equal(fake.volumes.size, 0);
  });
});

test("disposable Docker executor refuses mutable images and linked fixtures", async () => {
  assert.throws(
    () => createDisposableDockerExecutor({ imageId: "tiangong-worker:dev", fixtureSource: "/tmp" }),
    /immutable sha256/u,
  );

  await withFixture(async (fixtureSource) => {
    const linked = `${fixtureSource}-link`;
    await symlink(fixtureSource, linked);
    try {
      let calls = 0;
      const executor = createDisposableDockerExecutor({
        imageId: IMAGE_ID,
        fixtureSource: linked,
        runDocker: async () => {
          calls += 1;
          throw new Error("must not execute");
        },
      });
      const result = await runCommand({
        runId: RUN_ID,
        command: ["node", "-e", "1"],
        cwd: "fixture",
        timeoutMs: 1000,
      }, { executor, env: {} });
      assert.equal(result.outcome, "outcome_uncertain");
      assert.equal(calls, 0);
    } finally {
      await rm(linked, { force: true });
    }
  });
});

test("disposable Docker executor never replaces or removes a foreign volume", async () => {
  await withFixture(async (fixtureSource) => {
    const calls = [];
    const runDocker = async (args) => {
      calls.push([...args]);
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          exitCode: 0,
          timedOut: false,
          stdout: JSON.stringify([{ Name: args[2], Labels: { "io.tiangong.owner": "foreign" } }]),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: `Error: No such object: ${args[2]}\n`,
        };
      }
      throw new Error(`unexpected Docker call: ${args.join(" ")}`);
    };
    const executor = createDisposableDockerExecutor({ imageId: IMAGE_ID, fixtureSource, runDocker });
    const response = await runCommand({
      runId: RUN_ID,
      command: ["node", "-e", "1"],
      cwd: "fixture",
      timeoutMs: 1000,
    }, { executor, env: {} });
    assert.equal(response.outcome, "outcome_uncertain");
    assert.equal(response.reason, "RUNNER_EXECUTOR_FAILED");
    assert.equal(calls.some((args) => args[0] === "volume" && args[1] === "rm"), false);
  });
});

test("RunnerPort rejects executor evidence that is not invocation-bound", async () => {
  const executor = async () => ({
    status: "completed",
    exitCode: 0,
    stdout: "",
    stderr: "",
    runnerEvidence: {
      schemaVersion: 1,
      runId: RUN_ID,
      invocationKey: "0".repeat(64),
      imageId: IMAGE_ID,
      policyDigest: "1".repeat(64),
      containerConfigDigest: "2".repeat(64),
      fixtureDigest: "3".repeat(64),
    },
  });
  const response = await runCommand({
    runId: RUN_ID,
    command: ["node", "-e", "1"],
    cwd: "fixture",
    timeoutMs: 1000,
  }, { executor, env: {} });
  assert.equal(response.outcome, "outcome_uncertain");
  assert.equal(response.reason, "RUNNER_EVIDENCE_INVALID");
});
