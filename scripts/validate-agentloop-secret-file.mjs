import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_FIELDS = new Set([
  "AGENTLOOP_ENDPOINT",
  "AGENTLOOP_LICENSE_KEY",
  "AGENTLOOP_PROJECT",
  "AGENTLOOP_WORKSPACE",
]);

export async function validateAgentLoopSecretFile(inputPath) {
  if (typeof inputPath !== "string" || inputPath.length === 0) throw new Error("AGENTLOOP_SECRET_FILE_REQUIRED");
  const path = resolve(inputPath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw new Error("AGENTLOOP_SECRET_FILE_UNSAFE");
  }
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 8192 || /\r/u.test(text)) throw new Error("AGENTLOOP_SECRET_FILE_INVALID");
  const values = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=([^\s\u0000-\u001f\u007f]+)$/u);
    if (!match || !EXPECTED_FIELDS.has(match[1]) || values.has(match[1])) throw new Error("AGENTLOOP_SECRET_FILE_INVALID");
    values.set(match[1], match[2]);
  }
  if (values.size !== EXPECTED_FIELDS.size) throw new Error("AGENTLOOP_SECRET_FILE_INCOMPLETE");
  const endpoint = new URL(values.get("AGENTLOOP_ENDPOINT"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^[A-Za-z0-9.-]+\.log\.aliyuncs\.com$/u.test(endpoint.hostname) ||
      endpoint.pathname !== "/apm/trace/opentelemetry") throw new Error("AGENTLOOP_ENDPOINT_INVALID");
  if (!/^[A-Za-z0-9._@-]{16,512}$/u.test(values.get("AGENTLOOP_LICENSE_KEY"))) throw new Error("AGENTLOOP_LICENSE_KEY_INVALID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/u.test(values.get("AGENTLOOP_PROJECT"))) throw new Error("AGENTLOOP_PROJECT_INVALID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/u.test(values.get("AGENTLOOP_WORKSPACE"))) throw new Error("AGENTLOOP_WORKSPACE_INVALID");
  return Object.freeze({ endpoint: endpoint.href, fieldCount: values.size });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await validateAgentLoopSecretFile(process.argv[2]);
    process.stdout.write("agentloop_secret_file=valid\n");
  } catch (error) {
    process.stderr.write(`agentloop_secret_file=invalid code=${error?.message || "UNKNOWN"}\n`);
    process.exitCode = 1;
  }
}
