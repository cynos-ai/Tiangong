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

async function loadSourceProfile(roleId) {
  return loadRoleProfileBundle({
    profilePath: join(WORKER_ROOT, "role-profiles", `${roleId}.json`),
    resourceRoot: WORKER_ROOT,
  });
}

async function profileFixture(t, roleId = "reviewer") {
  const root = await mkdtemp(join(tmpdir(), "tiangong-role-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(WORKER_ROOT, "role-profiles"), join(root, "role-profiles"), { recursive: true });
  await cp(join(WORKER_ROOT, "roles"), join(root, "roles"), { recursive: true });
  await cp(join(WORKER_ROOT, "practices"), join(root, "practices"), { recursive: true });
  return {
    profilePath: join(root, "role-profiles", `${roleId}.json`),
    resourceRoot: root,
  };
}

async function rejectsProfile(paths, pattern = /role profile|resource|methodology/iu) {
  await assert.rejects(
    loadRoleProfileBundle(paths),
    (error) => error instanceof RoleProfileError && pattern.test(error.message),
  );
}

test("valid fixed profiles load frozen code-owned role context", async () => {
  const kernel = await loadSourceProfile("kernel");
  const reviewer = await loadSourceProfile("reviewer");

  assert.equal(Object.isFrozen(kernel), true);
  assert.equal(Object.isFrozen(kernel.profile), true);
  assert.equal(Object.isFrozen(reviewer.tools), true);
  assert.deepEqual(kernel.profile.toolIds, ["read", "write"]);
  assert.deepEqual(reviewer.profile, {
    schemaVersion: 2,
    roleId: "reviewer",
    title: "Reviewer",
    practiceIds: ["review"],
    targetKindIds: ["file", "directory_snapshot", "commit", "git_diff"],
    toolIds: [
      "start_work", "extend_scope", "read", "inspect_directory", "inspect_repository", "check_completion", "abandon_work",
    ],
    gatePolicyId: "reviewer-v2",
    roleSkillId: "reviewer-v2",
  });
  assert.equal(reviewer.practices[0].definition.id, "review");
  assert.equal(reviewer.practices[0].definition.version, 2);
  assert.equal(reviewer.practices[0].methodology.id, "review-v2");
  assert.deepEqual(reviewer.targetKinds.map((kind) => kind.id), ["file", "directory_snapshot", "commit", "git_diff"]);
  assert.match(buildBaseSystemPrompt(reviewer), /static-only review/u);
  assert.match(buildBaseSystemPrompt(reviewer), new RegExp(reviewer.profileDigest, "u"));

  assert.equal(assertRuntimeProfileMaterialized(kernel), kernel);
  assert.equal(assertRuntimeProfileMaterialized(reviewer), reviewer);
  assert.throws(
    () => assertRuntimeProfileMaterialized(Object.freeze({
      profile: Object.freeze({ roleId: "kernel", toolIds: ["read", "write"] }),
      profileDigest: kernel.profileDigest,
      tools: Object.freeze(kernel.tools),
    })),
    (error) => error instanceof RoleProfileError && error.reasonCode === "PROFILE_BUNDLE_INVALID",
  );
});

test("the leader profile loads practice-less with the closed coordination tool surface", async () => {
  const leader = await loadSourceProfile("leader");
  assert.equal(Object.isFrozen(leader), true);
  assert.equal(leader.profile.roleId, "leader");
  assert.deepEqual(leader.profile.practiceIds, []);
  assert.equal(leader.practices.length, 0);
  assert.deepEqual(leader.profile.toolIds, [
    "team_create_project",
    "team_dispatch_task",
    "team_check_result",
    "team_decide_task",
    "team_report",
  ]);
  assert.equal(leader.roleSkill.id, "leader-v1");
  assert.match(leader.roleSkill.text, /Tiangong Team Leader/u);
  assert.equal(assertRuntimeProfileMaterialized(leader), leader);
  assert.match(buildBaseSystemPrompt(leader), /Tiangong Team Leader/u);
  assert.match(buildBaseSystemPrompt(leader), new RegExp(leader.profileDigest, "u"));
});

test("closed registries deny Reviewer mutation and unknown capability selection", async () => {
  const registries = roleRegistrySnapshot();
  assert.equal(Object.isFrozen(registries), true);
  const reviewer = await loadSourceProfile("reviewer");
  assert.notEqual(reviewer.gatePolicy, registries.gatePolicies["reviewer-v2"]);
  assert.notEqual(reviewer.tools[0], registries.tools.start_work);
  assert.deepEqual(registries.roles.reviewer.toolIds, [
    "start_work",
    "extend_scope",
    "read",
    "inspect_directory",
    "inspect_repository",
    "check_completion",
    "abandon_work",
  ]);
  for (const toolId of ["write", "edit", "bash"]) {
    assert.equal(registries.roles.reviewer.toolIds.includes(toolId), false);
    assert.equal(registries.gatePolicies["reviewer-v2"].toolIds.includes(toolId), false);
  }
  assert.equal(Object.hasOwn(registries.tools, "unknown"), false);
  assert.deepEqual(registries.tools.read.materializedRoleIds, ["kernel", "reviewer"]);
  assert.deepEqual(registries.tools.write.profileRoleIds, ["kernel"]);
});

test("profile schema, IDs, duplicates, and digest spoofing fail closed", async (t) => {
  const paths = await profileFixture(t);
  const original = JSON.parse(await readFile(paths.profilePath, "utf8"));
  const variants = [
    { ...original, unexpected: true },
    Object.fromEntries(Object.entries(original).filter(([key]) => key !== "roleSkillId")),
    { ...original, schemaVersion: 1 },
    Object.fromEntries(Object.entries(original).filter(([key]) => key !== "targetKindIds")),
    { ...original, roleId: "unknown" },
    { ...original, toolIds: [...original.toolIds, "read"] },
    { ...original, toolIds: [...original.toolIds.slice(0, -1), "write"] },
    { ...original, roleSkillId: "unknown" },
    { ...original, title: "Reviewer elevated by prompt" },
  ];
  for (const variant of variants) {
    await writeFile(paths.profilePath, `${JSON.stringify(variant)}\n`);
    await rejectsProfile(paths, /profile|role|field|identifier|version/iu);
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

  const missing = await profileFixture(t);
  await rm(join(missing.resourceRoot, "roles", "reviewer", "role.md"));
  await rejectsProfile(missing, /missing/u);

  const linked = await profileFixture(t);
  const linkedMethodology = join(linked.resourceRoot, "practices", "review", "methodology.md");
  const originalMethodology = `${linkedMethodology}.original`;
  await cp(linkedMethodology, originalMethodology);
  await rm(linkedMethodology);
  await symlink(originalMethodology, linkedMethodology);
  await rejectsProfile(linked, /symbolic link/u);

  const oversized = await profileFixture(t);
  await writeFile(
    join(oversized.resourceRoot, "practices", "review", "methodology.md"),
    "x".repeat(32 * 1024 + 1),
  );
  await rejectsProfile(oversized, /size/u);

  const invalidUtf8 = await profileFixture(t);
  await writeFile(join(invalidUtf8.resourceRoot, "roles", "reviewer", "role.md"), Buffer.from([0xff]));
  await rejectsProfile(invalidUtf8, /digest|UTF-8/iu);

  const digestMismatch = await profileFixture(t);
  const rolePath = join(digestMismatch.resourceRoot, "roles", "reviewer", "role.md");
  await writeFile(rolePath, `${await readFile(rolePath, "utf8")}tampered\n`);
  await rejectsProfile(digestMismatch, /digest/u);
});

test("profile path is fixed and environment or assignment-shaped input cannot select a role", async () => {
  const before = {
    profile: process.env.TIANGONG_PROFILE_PATH,
    role: process.env.TIANGONG_ROLE_ID,
    worker: process.env.AGENTTEAMS_WORKER_NAME,
  };
  try {
    process.env.TIANGONG_PROFILE_PATH = "/tmp/spoofed-profile.json";
    process.env.TIANGONG_ROLE_ID = "kernel";
    process.env.AGENTTEAMS_WORKER_NAME = "reviewer-but-elevated";
    assert.equal(FIXED_PROFILE_PATH, "/opt/tiangong-worker/profile.json");
    assert.equal(FIXED_RESOURCE_ROOT, "/opt/tiangong-worker");
    const reviewer = await loadSourceProfile("reviewer");
    assert.equal(reviewer.profile.roleId, "reviewer");
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
