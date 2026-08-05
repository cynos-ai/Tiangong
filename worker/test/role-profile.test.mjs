import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertRuntimeProfileMaterialized,
  FIXED_PROFILE_PATH,
  FIXED_RESOURCE_ROOT,
  loadRoleProfileBundle,
  roleRegistrySnapshot,
  RoleProfileError,
} from "../agent/config/role-profile.mjs";
import { buildBaseSystemPrompt } from "../agent/context/base-system-prompt.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEAM_ROLES = ["leader", "designer", "implementor", "assessor", "operator"];

async function loadSourceProfile(roleId) {
  return loadRoleProfileBundle({
    profilePath: join(WORKER_ROOT, "role-profiles", `${roleId}.json`),
    resourceRoot: WORKER_ROOT,
  });
}

async function profileFixture(t, roleId = "leader") {
  const root = await mkdtemp(join(tmpdir(), "tiangong-role-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(WORKER_ROOT, "role-profiles"), join(root, "role-profiles"), { recursive: true });
  await cp(join(WORKER_ROOT, "roles"), join(root, "roles"), { recursive: true });
  await cp(join(WORKER_ROOT, "skills"), join(root, "skills"), { recursive: true });
  return { profilePath: join(root, "role-profiles", `${roleId}.json`), resourceRoot: root };
}

async function rejectsProfile(paths, pattern = /role profile|resource|SOUL|Skill/iu) {
  await assert.rejects(
    loadRoleProfileBundle(paths),
    (error) => error instanceof RoleProfileError && pattern.test(error.message),
  );
}

test("all five responsibility profiles load frozen SOUL and Skill context", async () => {
  for (const roleId of TEAM_ROLES) {
    const bundle = await loadSourceProfile(roleId);
    assert.equal(Object.isFrozen(bundle), true);
    assert.equal(Object.isFrozen(bundle.profile), true);
    assert.equal(Object.isFrozen(bundle.soul), true);
    assert.equal(Object.isFrozen(bundle.skills), true);
    assert.equal(bundle.profile.roleId, roleId);
    assert.equal(bundle.runtimeKind, roleId === "leader" ? "leader" : "member");
    assert.equal(bundle.profile.skillIds.length, 1);
    assert.equal(bundle.skills[0].id, bundle.profile.skillIds[0]);
    assert.equal(assertRuntimeProfileMaterialized(bundle), bundle);
    assert.match(buildBaseSystemPrompt(bundle), new RegExp(bundle.profile.title, "u"));
    assert.match(buildBaseSystemPrompt(bundle), new RegExp(bundle.skills[0].id, "u"));
    assert.match(buildBaseSystemPrompt(bundle), new RegExp(bundle.profileDigest, "u"));
  }
  const kernel = await loadSourceProfile("kernel");
  assert.equal(kernel.runtimeKind, "core");
  assert.deepEqual(kernel.profile.toolIds, ["read", "write"]);
  assert.equal(assertRuntimeProfileMaterialized(kernel), kernel);
});

test("closed registries contain no Reviewer or Practice capability", () => {
  const registries = roleRegistrySnapshot();
  assert.equal(Object.isFrozen(registries), true);
  assert.equal(Object.hasOwn(registries.roles, "reviewer"), false);
  assert.equal(Object.hasOwn(registries, "practices"), false);
  assert.equal(Object.hasOwn(registries, "methodologySkills"), false);
  assert.deepEqual(Object.keys(registries.roles), ["kernel", ...TEAM_ROLES]);
  for (const role of TEAM_ROLES) {
    assert.equal(registries.roles[role].skillIds.length, 1);
    assert.equal(registries.roles[role].toolIds.includes("bash"), false);
  }
});

test("profile schema, IDs, duplicate Skills, and digest spoofing fail closed", async (t) => {
  const paths = await profileFixture(t);
  const original = JSON.parse(await readFile(paths.profilePath, "utf8"));
  const variants = [
    { ...original, unexpected: true },
    Object.fromEntries(Object.entries(original).filter(([key]) => key !== "soulId")),
    { ...original, schemaVersion: 2 },
    { ...original, roleId: "unknown" },
    { ...original, skillIds: [...original.skillIds, ...original.skillIds] },
    { ...original, skillIds: ["unknown-skill"] },
    { ...original, toolIds: [...original.toolIds, "read"] },
    { ...original, gatePolicyId: "unknown-policy" },
  ];
  for (const variant of variants) {
    await writeFile(paths.profilePath, `${JSON.stringify(variant)}\n`);
    await rejectsProfile(paths, /profile|role|field|identifier|version|Skill/iu);
  }
});

test("missing, symlinked, oversized, invalid UTF-8, and digest-mismatched resources fail closed", async (t) => {
  const missingProfile = await profileFixture(t);
  await rm(missingProfile.profilePath);
  await rejectsProfile(missingProfile, /profile is missing/u);

  const linkedProfile = await profileFixture(t);
  const originalProfile = `${linkedProfile.profilePath}.original`;
  await cp(linkedProfile.profilePath, originalProfile);
  await rm(linkedProfile.profilePath);
  await symlink(originalProfile, linkedProfile.profilePath);
  await rejectsProfile(linkedProfile, /symbolic link/u);

  const missingSoul = await profileFixture(t);
  await rm(join(missingSoul.resourceRoot, "roles", "leader", "SOUL.md"));
  await rejectsProfile(missingSoul, /missing/u);

  const linkedSkill = await profileFixture(t);
  const skillPath = join(linkedSkill.resourceRoot, "skills", "leader", "coordination.md");
  const originalSkill = `${skillPath}.original`;
  await cp(skillPath, originalSkill);
  await rm(skillPath);
  await symlink(originalSkill, skillPath);
  await rejectsProfile(linkedSkill, /symbolic link/u);

  const oversized = await profileFixture(t);
  await writeFile(join(oversized.resourceRoot, "skills", "leader", "coordination.md"), "x".repeat(16 * 1024 + 1));
  await rejectsProfile(oversized, /size/u);

  const invalidUtf8 = await profileFixture(t);
  await writeFile(join(invalidUtf8.resourceRoot, "skills", "leader", "coordination.md"), Buffer.from([0xff]));
  await rejectsProfile(invalidUtf8, /digest|UTF-8/iu);

  const digestMismatch = await profileFixture(t);
  const skillFile = join(digestMismatch.resourceRoot, "skills", "leader", "coordination.md");
  await writeFile(skillFile, `${await readFile(skillFile, "utf8")}tampered\n`);
  await rejectsProfile(digestMismatch, /digest/u);
});

test("profile path is fixed and environment or assignment input cannot select a role", async () => {
  const before = {
    profile: process.env.TIANGONG_PROFILE_PATH,
    role: process.env.TIANGONG_ROLE_ID,
    worker: process.env.AGENTTEAMS_WORKER_NAME,
  };
  try {
    process.env.TIANGONG_PROFILE_PATH = "/tmp/spoofed-profile.json";
    process.env.TIANGONG_ROLE_ID = "kernel";
    process.env.AGENTTEAMS_WORKER_NAME = "leader-but-elevated";
    assert.equal(FIXED_PROFILE_PATH, "/opt/tiangong-worker/profile.json");
    assert.equal(FIXED_RESOURCE_ROOT, "/opt/tiangong-worker");
    const leader = await loadSourceProfile("leader");
    assert.equal(leader.profile.roleId, "leader");
  } finally {
    for (const [name, value] of Object.entries({
      TIANGONG_PROFILE_PATH: before.profile,
      TIANGONG_ROLE_ID: before.role,
      AGENTTEAMS_WORKER_NAME: before.worker,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
