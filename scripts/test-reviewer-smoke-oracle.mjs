#!/usr/bin/env node

import assert from "node:assert/strict";

import { expectedReadTargets } from "../smoke-testing/support/reviewer-oracle-policy.mjs";

assert.deepEqual(
  expectedReadTargets({ expectedA: "a.txt", expectedB: "-", readPhase: "all" }),
  ["a.txt"],
);
assert.deepEqual(
  expectedReadTargets({ expectedA: "a.txt", expectedB: "b.txt", readPhase: "a-only" }),
  ["a.txt"],
);
assert.deepEqual(
  expectedReadTargets({ expectedA: "a.txt", expectedB: "b.txt", readPhase: "all" }),
  ["a.txt", "b.txt"],
);
assert.throws(
  () => expectedReadTargets({ expectedA: "", expectedB: "b.txt", readPhase: "all" }),
  /invalid Reviewer oracle read policy input/u,
);

process.stdout.write("Reviewer smoke oracle policy contract passed.\n");
