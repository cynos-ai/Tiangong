import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
test("M0 builds one generic tg-worker and no role-specific target or resource", async () => {
  const [dockerfile, build] = await Promise.all([readFile(new URL("worker/Dockerfile", root), "utf8"), readFile(new URL("scripts/build-worker-image.sh", root), "utf8")]);
  assert.match(dockerfile, /FROM worker-base AS tg-worker/u); assert.match(build, /readonly IMAGE="tg-worker:dev"/u);
  assert.doesNotMatch(dockerfile, /FROM .* AS (?:leader|designer|implementor|assessor|operator)/u);
  assert.doesNotMatch(dockerfile, /COPY (?:role-profiles|roles|skills)\//u);
  assert.doesNotMatch(build, /tiangong-worker-(?:leader|designer|implementor|assessor|operator)/u);
});
