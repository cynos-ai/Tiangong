import { promises as dns } from "node:dns";
import { createHash } from "node:crypto";
import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";

const fixturePath = "/workspace/fixture/input.txt";
const scratchPath = "/workspace/scratch/result.json";
const expectedInput = "tiangong-runner-fixture-v1\n";

function requiredList(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value.split(",").filter(Boolean);
}

async function assertWriteDenied(path, content) {
  try {
    await appendFile(path, content);
  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "EROFS") return;
    throw error;
  }
  throw new Error(`write unexpectedly succeeded: ${path}`);
}

const runId = process.env.TIANGONG_RUN_ID;
if (!/^run-[0-9a-f-]+$/u.test(runId ?? "")) throw new Error("invalid run identity");

const forbiddenEnvNames = requiredList("TIANGONG_FORBIDDEN_ENV_NAMES");
for (const name of forbiddenEnvNames) {
  if (Object.hasOwn(process.env, name)) throw new Error(`forbidden environment key present: ${name}`);
}

await access(fixturePath, constants.R_OK);
const input = await readFile(fixturePath, "utf8");
if (input !== expectedInput) throw new Error("fixture content mismatch");
await assertWriteDenied(fixturePath, "forbidden\n");
await assertWriteDenied("/tiangong-forbidden-root-write", "forbidden\n");

try {
  await access("/var/run/docker.sock", constants.F_OK);
  throw new Error("container-runtime socket is visible");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const interfaces = os.networkInterfaces();
for (const addresses of Object.values(interfaces)) {
  for (const address of addresses ?? []) {
    if (!address.internal && address.address !== "127.0.0.1" && address.address !== "::1") {
      throw new Error(`non-loopback network address present on ${address.address}`);
    }
  }
}

for (const target of requiredList("TIANGONG_FORBIDDEN_NETWORK_TARGETS")) {
  try {
    await dns.lookup(target);
    throw new Error(`forbidden control-plane target resolved: ${target}`);
  } catch (error) {
    if (error?.message?.startsWith("forbidden control-plane")) throw error;
  }
}

const result = {
  runId,
  fixtureSha256: createHash("sha256").update(input).digest("hex"),
  credentialKeysAbsent: true,
  fixtureReadOnly: true,
  rootFilesystemReadOnly: true,
  runtimeSocketAbsent: true,
  networkLoopbackOnly: true,
  controlPlaneNamesUnresolved: true,
};
await writeFile(scratchPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
process.stdout.write("runner_probe=pass\n");
