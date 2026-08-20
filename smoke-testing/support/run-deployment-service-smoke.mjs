#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../worker/agent/canonical-json.mjs";

const owner = "io.tiangong.smoke=deployment-service";
const network = "tiangong-deployment-smoke";
const service = "tiangong-deployment-service-smoke";
const configVolume = "tiangong-deployment-smoke-config";
const stateVolume = "tiangong-deployment-smoke-state";
const image = "tg-deployment-service:dev";
const previous = "a".repeat(64);
const artifact = "b".repeat(64);
const root = await mkdtemp(join(tmpdir(), "tiangong-deployment-smoke-"));
const configPath = join(root, "config.json");

function docker(args, { input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const out = []; const err = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("docker command timed out")); }, timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }); });
    if (input !== undefined) child.stdin.end(input);
  });
}
async function requireDocker(args, label, options) {
  const result = await docker(args, options);
  if (result.code !== 0) throw new Error(`${label}: ${result.stderr.trim().slice(0, 1024)}`);
  return result;
}
async function absent(kind, name) {
  const result = await docker([kind, "inspect", name]);
  if (result.code === 0) throw new Error(`owned ${kind} already exists: ${name}`);
}

const capability = randomBytes(32).toString("base64url");
try {
  await Promise.all([
    absent("network", network), absent("container", service),
    absent("volume", configVolume), absent("volume", stateVolume),
  ]);
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1, listenPort: 8790, targetId: "smoke-target", previousDigest: previous,
    capabilityDigest: sha256(capability), faultMode: "none",
  })}\n`, { mode: 0o444 });
  await chmod(configPath, 0o444);
  await requireDocker(["network", "create", "--internal", "--label", owner, network], "network create failed");
  await requireDocker(["volume", "create", "--label", owner, configVolume], "config volume create failed");
  await requireDocker(["volume", "create", "--label", owner, stateVolume], "state volume create failed");
  await requireDocker(["run", "--rm", "-i", "-v", `${configVolume}:/dest`, "alpine:3.20", "sh", "-c", "umask 077; cat >/dest/config.json; chmod 444 /dest/config.json"], "config copy failed", { input: await (await import("node:fs/promises")).readFile(configPath) });
  await requireDocker(["run", "--rm", "-v", `${stateVolume}:/state`, "alpine:3.20", "sh", "-c", "chown 65532:65532 /state; chmod 700 /state"], "state preparation failed");
  const imageId = (await requireDocker(["image", "inspect", "--format", "{{.Id}}", image], "image inspect failed")).stdout.trim();
  await requireDocker(["create", "--name", service, "--label", owner, "--network", network,
    "--read-only", "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "128", "--memory", "256m", "--cpus", "0.5", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=8m",
    "--mount", `type=volume,src=${configVolume},dst=/run/tiangong-deployment-service,readonly`,
    "--mount", `type=volume,src=${stateVolume},dst=/var/lib/tiangong-deployment-service`, imageId], "service create failed");
  await requireDocker(["start", service], "service start failed");
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    const logs = await docker(["logs", service]);
    if (logs.stdout.includes("deployment_service_ready=pass")) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("deployment service readiness timed out");
  console.log("deployment_service_ready=pass");

  const program = `
const endpoint='http://${service}:8790'; const cap=process.env.TEST_CAP;
async function call(path,method='POST',body){const r=await fetch(endpoint+path,{method,headers:{authorization:'Bearer '+cap,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}}
const initial=await call('/v1/status','GET'); if(initial.body.status.currentDigest!=='${previous}')process.exit(11);
const stage={operationId:'deploy-smoke',artifactDigest:'${artifact}',expectedCurrentDigest:'${previous}',rollbackDigest:'${previous}'};
if((await call('/v1/stage','POST',stage)).body.replayed!==false)process.exit(12);
if((await call('/v1/stage','POST',stage)).body.replayed!==true)process.exit(13);
if((await call('/v1/activate','POST',{operationId:'deploy-smoke'})).status!==200)process.exit(14);
const verify=await call('/v1/verify','POST',{operationId:'deploy-smoke',phase:'post_deploy',expectedDigest:'${artifact}'}); if(verify.body.event.healthy!==true)process.exit(15);
const final=await call('/v1/status','GET'); if(final.body.status.currentDigest!=='${artifact}')process.exit(16);
const denied=await fetch(endpoint+'/v1/status',{headers:{authorization:'Bearer '+('x'.repeat(32))}}); if(denied.status!==403)process.exit(17);
console.log('deployment_service_activate_verify=pass'); console.log('deployment_service_unauthorized=pass');
`;
  const client = await docker(["run", "--rm", "--network", network, "--read-only", "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--env", `TEST_CAP=${capability}`, "--entrypoint", "/usr/bin/node", imageId, "--input-type=module", "-e", program], { timeoutMs: 120_000 });
  if (client.code !== 0) throw new Error(`deployment client failed: ${client.stderr.trim().slice(0, 1024)}`);
  process.stdout.write(client.stdout);
  console.log("deployment_service_machine_evidence=pass previous_digest=" + previous + " current_digest=" + artifact);
} finally {
  capability.fill?.(0);
  await docker(["rm", "-f", service]);
  await docker(["volume", "rm", configVolume]);
  await docker(["volume", "rm", stateVolume]);
  await docker(["network", "rm", network]);
  await rm(root, { recursive: true, force: true });
  const residues = await Promise.all([["container", service], ["volume", configVolume], ["volume", stateVolume], ["network", network]].map(async ([kind, name]) => (await docker([kind, "inspect", name])).code === 0));
  if (residues.some(Boolean)) throw new Error("deployment service cleanup left an owned resource");
  console.log("deployment_service_cleanup=pass");
}
