import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadAgentPackages, resolveAgentRuntimeFromEnvironment, resolveMemberAgent } from "../agent/packages/loader.mjs";
import { createMemberConfig } from "../agent/team/coordination-store.mjs";

const NOW = "2026-08-19T00:00:00.000Z";
const CONFIG = Object.freeze({
  leader: { runtime: "openclaw-built-in", model: "glm-5", skills: ["work-coordination", "work-planning"] },
  architect: { runtime: "openclaw-built-in", model: "glm-5", skills: ["work-planning", "plan-challenge"] },
  challenger: { runtime: "openclaw-built-in", model: "glm-5", skills: ["plan-challenge"] },
  developer: { runtime: "openclaw-built-in", model: "glm-5", skills: ["test-driven-development", "independent-code-review", "scenario-testing"] },
  reviewer: { runtime: "openclaw-built-in", model: "glm-5", skills: ["independent-code-review"] },
  tester: { runtime: "openclaw-built-in", model: "glm-5", skills: ["scenario-testing"] },
});

function member(role, override = {}) {
  const config = CONFIG[role];
  return createMemberConfig({ memberId: `${role}-1`, teamId: "team-1", workerName: `${role}-1`, matrixUserId: `@${role}:example.test`, role, controlProfileId: "profile-1", enabled: true, createdAt: NOW, revision: 1, runtime: config.runtime, model: config.model, agentPackageId: `tiangong-${role}`, agentPackageVersion: "1.0.0", allowedSkills: config.skills, ...override });
}

test("M1 installs exactly six long-lived professional Agent packages", async () => {
  const { packages } = await loadAgentPackages();
  assert.deepEqual(packages.map((entry) => entry.responsibility).sort(), Object.keys(CONFIG).sort());
  for (const entry of packages) {
    assert.match(entry.packageDigest, /^[a-f0-9]{64}$/u);
    assert.equal(entry.sessionPolicy, entry.responsibility === "leader" ? "one-session-per-work" : "one-session-per-task");
    assert.equal(entry.defaultModel, "glm-5");
    assert.match(entry.instructions, new RegExp(`# ${entry.displayName}`, "u"));
  }
});

test("MemberConfig resolves identity, package, runtime, and installed-intersect-allowed Skills", async () => {
  for (const role of Object.keys(CONFIG)) {
    const resolved = await resolveMemberAgent({ memberConfig: member(role) });
    assert.equal(resolved.agentPackage.responsibility, role);
    assert.equal(resolved.memberRevision, 1);
    assert.deepEqual(resolved.effectiveSkills.map((skill) => skill.skillId), CONFIG[role].skills);
  }
  const subset = await resolveMemberAgent({ memberConfig: member("developer", { allowedSkills: ["test-driven-development"] }) });
  assert.deepEqual(subset.effectiveSkills.map((skill) => skill.skillId), ["test-driven-development"]);
  const officialOverride = await resolveMemberAgent({ memberConfig: member("reviewer", { model: "qwen3.7-plus", revision: 2 }) });
  assert.equal(officialOverride.model, "qwen3.7-plus");
  assert.equal(officialOverride.memberRevision, 2);
});

test("Agent package mismatch and uninstalled Skill fail closed", async () => {
  await assert.rejects(() => resolveMemberAgent({ memberConfig: member("reviewer", { agentPackageId: "tiangong-architect" }) }), (error) => error.code === "MEMBER_AGENT_MISMATCH");
  await assert.rejects(() => resolveMemberAgent({ memberConfig: member("challenger", { allowedSkills: ["work-planning"] }) }), (error) => error.code === "SKILL_NOT_INSTALLED_FOR_AGENT");
  await assert.rejects(() => resolveMemberAgent({ memberConfig: member("tester", { enabled: false }) }), (error) => error.code === "MEMBER_AGENT_INVALID");
});

test("changed Skill content is rejected against the Agent package digest lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-skill-lock-")); t.after(() => rm(root, { recursive: true, force: true }));
  const skillsRoot = join(root, "skills"); await cp(fileURLToPath(new URL("../skills/", import.meta.url)), skillsRoot, { recursive: true });
  await appendFile(join(skillsRoot, "test-driven-development", "SKILL.md"), "\nchanged\n");
  await assert.rejects(() => resolveMemberAgent({ memberConfig: member("developer"), skillsRoot }), (error) => error.code === "SKILL_LOCK_MISMATCH");
});

test("deployment environment validates all six Agent packages and effective Skills", async () => {
  for (const [role, config] of Object.entries(CONFIG)) {
    const resolved = await resolveAgentRuntimeFromEnvironment({ TIANGONG_MEMBER_ID: `${role}-1`, TIANGONG_MEMBER_RESPONSIBILITY: role, TIANGONG_MEMBER_RUNTIME: config.runtime, TIANGONG_MEMBER_MODEL: config.model, TIANGONG_MEMBER_AGENT_PACKAGE_ID: `tiangong-${role}`, TIANGONG_MEMBER_REVISION: "1", TIANGONG_MEMBER_AGENT_PACKAGE_VERSION: "1.0.0", TIANGONG_MEMBER_ALLOWED_SKILLS: config.skills.join(",") });
    assert.equal(resolved.agentPackage.responsibility, role);
    assert.equal(resolved.model, config.model);
  }
  await assert.rejects(() => resolveAgentRuntimeFromEnvironment({ TIANGONG_MEMBER_RESPONSIBILITY: "developer", TIANGONG_MEMBER_RUNTIME: "openclaw-built-in", TIANGONG_MEMBER_MODEL: "glm-5", TIANGONG_MEMBER_AGENT_PACKAGE_ID: "tiangong-developer", TIANGONG_MEMBER_REVISION: "1", TIANGONG_MEMBER_AGENT_PACKAGE_VERSION: "1.0.0", TIANGONG_MEMBER_ALLOWED_SKILLS: "work-coordination" }), (error) => error.code === "SKILL_NOT_INSTALLED_FOR_AGENT");
});
