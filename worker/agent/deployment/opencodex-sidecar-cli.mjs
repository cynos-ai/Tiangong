import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OpenCodexSidecarController } from "./opencodex-sidecar.mjs";
import { createDockerOpenCodexSidecarAdapter } from "./opencodex-sidecar-adapter.mjs";

const STATE_DIR = process.env.TIANGONG_OPENCODEX_STATE_DIR || "/var/lib/tiangong-opencodex";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readBinding() {
  if (process.argv.includes("--binding-stdin")) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/u, ""));
  }
  const path = arg("--binding");
  if (!path) throw new Error("OpenCodex provision requires --binding or --binding-stdin");
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeSnapshot(path, snapshot) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp-${process.pid}`, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(`${path}.tmp-${process.pid}`, path);
}

async function main() {
  const action = process.argv[2];
  if (!["provision", "ready", "reconcile", "rotate", "drain", "remove", "status"].includes(action)) throw new Error("OpenCodex sidecar action is invalid");
  let snapshot;
  let binding;
  if (action === "provision") binding = await readBinding();
  else {
    const snapshotPath = arg("--snapshot");
    if (!snapshotPath) throw new Error("OpenCodex sidecar action requires --snapshot");
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    binding = snapshot.binding;
  }
  const sidecarId = snapshot?.sidecarId ?? `opencodex-${binding.workerId}`;
  const snapshotPath = arg("--snapshot") || join(STATE_DIR, `${sidecarId}.controller.json`);
  const adapter = createDockerOpenCodexSidecarAdapter({
    dockerPath: process.env.DOCKER_PATH || "/usr/local/bin/docker",
    stateDir: STATE_DIR,
  });
  const controller = new OpenCodexSidecarController({ adapter, snapshot });
  try {
    let result;
    if (action === "provision") result = await controller.provision(binding);
    else if (action === "ready") result = await controller.ready();
    else if (action === "reconcile") result = await controller.reconcile();
    else if (action === "status") result = await controller.reconcile();
    else if (action === "rotate") result = await controller.rotate({ credentialRef: arg("--credential-ref"), generation: Number(arg("--generation")) });
    else if (action === "drain") result = await controller.drain();
    else result = await controller.remove();
    await writeSnapshot(snapshotPath, controller.snapshot());
    process.stdout.write(`${JSON.stringify({ action, phase: controller.phase, receipt: result.receipt })}\n`);
  } catch (error) {
    try { await writeSnapshot(snapshotPath, controller.snapshot()); } catch { /* preserve the primary lifecycle error */ }
    process.stderr.write(`opencodex_sidecar_action=fail code=${error?.code ?? "sidecar-action-failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
