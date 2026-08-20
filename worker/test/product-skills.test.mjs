import assert from "node:assert/strict";
import test from "node:test";

import { loadInstalledSkills } from "../agent/skills/catalog.mjs";

const EXPECTED = ["independent-code-review", "plan-challenge", "scenario-testing", "test-driven-development", "work-coordination", "work-planning"];

test("M2 installs six portable versioned Skills with trigger and behavior boundaries", async () => {
  const { skills } = await loadInstalledSkills();
  assert.deepEqual(skills.map((skill) => skill.skillId), EXPECTED);
  for (const skill of skills) {
    assert.equal(skill.version, "1.0.0"); assert.match(skill.contentDigest, /^[a-f0-9]{64}$/u);
    assert.ok(skill.triggers.shouldTrigger.length >= 2); assert.ok(skill.triggers.shouldNotTrigger.length >= 2); assert.ok(skill.triggers.ambiguous.length >= 1);
    assert.ok(skill.behavior.success.length >= 1); assert.ok(skill.behavior.blocked.length >= 1); assert.ok(skill.behavior.cleanup.length >= 1);
    assert.match(skill.instructions, /Security boundary/u);
  }
});

test("portable Skills contain no private dependency and claim no authority grant", async () => {
  const { skills } = await loadInstalledSkills();
  for (const skill of skills) {
    assert.doesNotMatch(skill.instructions, /Tiangong-internal|\/home\/|\.\.\/Tiangong-internal/u);
    assert.match(skill.instructions, /does not grant|grants no|cannot grant/u);
  }
});
