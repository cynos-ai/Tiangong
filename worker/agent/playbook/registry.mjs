// Closed TeamPlaybook registry (architecture §5 / §7).
//
// Like roles/registry.mjs, this is a code-owned, deep-frozen closed registry.
// The contentDigest is the canonical digest of the package manifest.json (see
// resolver.mjs#loadPlaybook); loading the package verifies the on-disk file
// against this entry, so the model cannot substitute a playbook by editing a
// file. A new playbook or version is a code change here, never a runtime input.

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const PLAYBOOK_PACKAGE_DIR = "software-change-delivery";

const registries = deepFreeze({
  playbooks: {
    "software-change-delivery@1.0.0": {
      versionedId: "software-change-delivery@1.0.0",
      playbookId: "software-change-delivery",
      version: "1.0.0",
      packageDir: PLAYBOOK_PACKAGE_DIR,
      contentDigest: "f3cb1b29dd8d5e2eece0e073a337d0babb9004f1e650cdccd0a4e90e12039c5d",
      roleSlots: ["team_leader", "designer", "implementor", "assessor", "operator"],
      taskKinds: ["design", "implement", "assess", "release"],
      taskKindRoles: {
        design: "designer",
        implement: "implementor",
        assess: "assessor",
        release: "operator",
      },
      maxRevisionWaves: 2,
      completionSchemaId: "software-change-delivery-result-v1",
      completionSchemaDigest: "44a9134a73b6d15f4b4502762fc887ad3d772b1bd16474a6b1cd160269819282",
      transitionPolicyId: "software-change-delivery-transition-v1",
    },
  },
});

export function closedPlaybookRegistries() {
  return registries;
}

export function playbookRegistryEntry(versionedId) {
  return registries.playbooks[versionedId];
}

export function findPlaybook(playbookId, version) {
  return Object.values(registries.playbooks).find((entry) => {
    if (entry.playbookId !== playbookId) return false;
    return version === undefined || entry.version === version;
  });
}

// Return the trusted closed-registry entry for a playbook. The entry is the
// source of truth (contentDigest + all fields) and is compiled into the code,
// so the runtime and the Worker image do not depend on the on-disk package
// file. readPlaybookManifest (below) additionally verifies the on-disk file
// against this entry for dev/build transparency.
export function getPlaybook(playbookId, version) {
  const entry = findPlaybook(playbookId, version);
  if (!entry) {
    throw new Error(`Unknown closed playbook: ${playbookId}${version ? `@${version}` : ""}`);
  }
  return entry;
}
