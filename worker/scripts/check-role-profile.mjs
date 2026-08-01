#!/usr/bin/env node

import {
  assertRuntimeProfileMaterialized,
  loadFixedRoleProfileBundle,
} from "../agent/config/role-profile.mjs";
import { buildBaseSystemPrompt } from "../agent/context/base-system-prompt.mjs";

function expectedRole(argv) {
  if (argv.length !== 2 || argv[0] !== "--expect-role" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(argv[1])) {
    throw new Error("Usage: check-role-profile --expect-role <role-id>");
  }
  return argv[1];
}

async function main() {
  const roleId = expectedRole(process.argv.slice(2));
  const bundle = await loadFixedRoleProfileBundle();
  if (bundle.profile.roleId !== roleId) throw new Error("Fixed image role does not match the expected role");
  buildBaseSystemPrompt(bundle);
  let runtimeReady = true;
  try {
    assertRuntimeProfileMaterialized(bundle);
  } catch (error) {
    if (error?.code !== "TIANGONG_ROLE_RUNTIME_UNAVAILABLE") throw error;
    runtimeReady = false;
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: bundle.schemaVersion,
    roleId: bundle.profile.roleId,
    profileDigest: bundle.profileDigest,
    roleSkillDigest: bundle.roleSkill.digest,
    methodologyDigests: bundle.practices.map((practice) => practice.methodology.digest),
    targetKindIds: bundle.profile.targetKindIds ?? [],
    materializedTargetKindIds: bundle.targetKinds
      .filter((kind) => kind.materializedRoleIds.includes(bundle.profile.roleId))
      .map((kind) => kind.id),
    toolIds: bundle.profile.toolIds,
    materializedToolIds: bundle.tools
      .filter((tool) => tool.materializedRoleIds.includes(bundle.profile.roleId))
      .map((tool) => tool.id),
    runtimeReady,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`check-role-profile: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
