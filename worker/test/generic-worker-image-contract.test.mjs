import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
test("M5 builds one generic tg-worker and no role-specific or legacy active target", async () => {
  const [dockerfile, dockerignore, build, plugin] = await Promise.all([readFile(new URL("worker/Dockerfile", root), "utf8"), readFile(new URL("worker/.dockerignore", root), "utf8"), readFile(new URL("scripts/build-worker-image.sh", root), "utf8"), readFile(new URL("worker/plugin/index.mjs", root), "utf8")]);
  assert.match(dockerfile, /FROM worker-base AS tg-worker/u); assert.match(build, /readonly IMAGE="tg-worker:dev"/u);
  assert.doesNotMatch(dockerfile, /FROM .* AS (?:leader|designer|implementor|assessor|operator)/u);
  assert.doesNotMatch(dockerfile, /COPY (?:role-profiles|roles)\//u);
  assert.match(dockerfile, /COPY agent-packages\/ \.\/agent-packages\//u);
  assert.match(dockerfile, /COPY skills\/ \.\/skills\//u);
  assert.match(dockerignore, /^legacy\/$/mu);
  assert.doesNotMatch(build, /tiangong-worker-(?:leader|designer|implementor|assessor|operator)/u);
  assert.doesNotMatch(build, /runner-broker|deployment-service|deployment-broker|opencodex|canary|capability-cache/u);
  assert.doesNotMatch(plugin, /registerNativeRunnerTool|tiangong_run_command/u);
});
