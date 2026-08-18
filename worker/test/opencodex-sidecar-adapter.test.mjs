import test from "node:test";
import assert from "node:assert/strict";

import { openCodexSidecarContainerName } from "../agent/deployment/opencodex-sidecar-adapter.mjs";

test("keeps short OpenCodex sidecar names readable", () => {
  assert.equal(
    openCodexSidecarContainerName("tiangong-leader-smoke-implementor"),
    "tiangong-opencodex-tiangong-leader-smoke-implementor",
  );
});

test("bounds long OpenCodex sidecar names for Docker DNS and keeps them distinct", () => {
  const first = openCodexSidecarContainerName(`worker-${"a".repeat(120)}`);
  const second = openCodexSidecarContainerName(`worker-${"b".repeat(120)}`);
  assert.ok(first.length <= 63);
  assert.ok(second.length <= 63);
  assert.notEqual(first, second);
  assert.match(first, /^tiangong-opencodex-worker-a{24}-[0-9a-f]{12}$/u);
});
