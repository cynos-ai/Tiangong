#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "../worker/agent/canonical-json.mjs";
import { loadRoleProfileBundle, assertRuntimeProfileMaterialized, roleRegistrySnapshot } from "../worker/agent/config/role-profile.mjs";
import { buildBaseSystemPrompt } from "../worker/agent/context/base-system-prompt.mjs";
import { readPlaybookManifest } from "../worker/agent/playbook/resolver.mjs";
import { inspectRunnerFixture } from "../worker/agent/runner/docker-executor.mjs";

const ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const WORKER_ROOT = join(ROOT, "worker");
const ROLES = ["leader", "designer", "implementor", "assessor", "operator"];
const EXPECTED_TOOLS = Object.freeze({
  leader: ["team_create_project", "team_dispatch_task", "team_check_result", "team_decide_task", "team_report"],
  designer: ["team_resolve_task", "team_submit_result"],
  implementor: ["team_resolve_task", "run_command", "team_submit_result"],
  assessor: ["team_resolve_task", "run_test_command", "team_submit_result"],
  operator: ["team_resolve_task", "deploy_release", "team_submit_result"],
});

function fail(message) {
  throw new Error(`DEMO_CONTRACT_INVALID: ${message}`);
}

async function loadSourceProfile(roleId) {
  return loadRoleProfileBundle({
    profilePath: join(WORKER_ROOT, "role-profiles", `${roleId}.json`),
    resourceRoot: WORKER_ROOT,
  });
}

function withoutSkills(bundle) {
  return Object.freeze({ ...bundle, skills: Object.freeze([]) });
}

async function main() {
  const registry = roleRegistrySnapshot();
  if (Object.hasOwn(registry.roles, "reviewer") || Object.hasOwn(registry, "practices")) {
    fail("historical Reviewer/Practice authority is present in the active registry");
  }

  const profiles = {};
  const skillEvaluation = {};
  for (const roleId of ROLES) {
    const bundle = await loadSourceProfile(roleId);
    assertRuntimeProfileMaterialized(bundle);
    if (bundle.profile.roleId !== roleId) fail(`profile role mismatch for ${roleId}`);
    if (bundle.profile.toolIds.join("\n") !== EXPECTED_TOOLS[roleId].join("\n")) {
      fail(`tool surface mismatch for ${roleId}`);
    }
    const withSkill = buildBaseSystemPrompt(bundle);
    const withoutSkill = buildBaseSystemPrompt(withoutSkills(bundle));
    if (!withSkill.includes(bundle.skills[0].id)) fail(`Skill is absent from the trusted ${roleId} context`);
    if (withSkill === withoutSkill) fail(`with/without Skill evaluation did not change ${roleId} context`);
    if (bundle.profileDigest !== sha256(await readFile(join(WORKER_ROOT, "role-profiles", `${roleId}.json`)))) {
      fail(`profile digest mismatch for ${roleId}`);
    }
    profiles[roleId] = {
      profileDigest: bundle.profileDigest,
      skillId: bundle.skills[0].id,
      skillDigest: bundle.skills[0].digest,
      toolIds: bundle.profile.toolIds,
    };
    skillEvaluation[roleId] = {
      withSkillPromptDigest: sha256(withSkill),
      withoutSkillPromptDigest: sha256(withoutSkill),
      toolSurfaceUnchanged: bundle.profile.toolIds.join("\n") === withoutSkills(bundle).profile.toolIds.join("\n"),
    };
  }

  const playbook = readPlaybookManifest("software-change-delivery");
  const lock = JSON.parse(await readFile(join(ROOT, "playbooks.lock.json"), "utf8"));
  const transitionPolicyDigest = playbook.fileDigests["transition-policy.mjs"];
  const locked = lock.playbooks?.find((entry) => entry.playbookId === playbook.playbookId && entry.version === playbook.version);
  if (!locked || locked.contentDigest !== playbook.contentDigest || locked.transitionPolicyDigest !== transitionPolicyDigest) {
    fail("playbook lock does not match the verified package");
  }
  for (const [relativePath, digest] of Object.entries(playbook.fileDigests)) {
    if (locked.fileDigests?.[relativePath] !== digest) fail(`playbook file lock mismatch for ${relativePath}`);
  }

  const fixture = await inspectRunnerFixture(join(ROOT, "smoke-testing", "fixtures", "runner-isolation"));
  const result = {
    status: "pass",
    playbook: {
      id: playbook.playbookId,
      version: playbook.version,
      contentDigest: playbook.contentDigest,
      transitionPolicyDigest,
    },
    fixtureDigest: fixture.digest,
    profiles,
    skillEvaluation,
    evaluationMeaning: "Skill text changes trusted context only; fixed profile, closed tool surface, and playbook authority remain unchanged.",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
