const REVIEW_CHECKPOINT_IDS = [
  "claim-schema-valid",
  "criteria-covered",
  "scope-matches-final",
  "targets-fully-consumed",
  "observation-targets-valid",
  "outcome-consistent",
  "static-review-limitation-recorded",
  "no-mutation-observed",
];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const registries = deepFreeze({
  roles: {
    kernel: {
      id: "kernel",
      title: "Tiangong Kernel",
      practiceIds: ["workspace-operations"],
      toolIds: ["read", "write"],
      gatePolicyId: "workspace-tools-v1",
      roleSkillId: "kernel-v1",
      profileDigest: "70f01dc2bb6a0b4b2a88ce56ea8eb95b489e9e831e71453f66fd783f833210f8",
    },
    reviewer: {
      id: "reviewer",
      title: "Reviewer",
      practiceIds: ["review"],
      targetKindIds: ["file", "directory_snapshot"],
      toolIds: ["start_work", "extend_scope", "read", "inspect_directory", "check_completion", "abandon_work"],
      gatePolicyId: "reviewer-v2",
      roleSkillId: "reviewer-v2",
      profileDigest: "117306115f251980d7bfd363d15990afc20c4a535d46f075c2bbfdad590fb639",
    },
  },
  targetKinds: {
    file: {
      id: "file",
      materializedRoleIds: ["reviewer"],
      captureVersion: "review-file-snapshot-v1",
    },
    directory_snapshot: {
      id: "directory_snapshot",
      materializedRoleIds: ["reviewer"],
      captureVersion: "review-directory-snapshot-v1",
    },
  },
  tools: {
    start_work: {
      id: "start_work",
      executionMode: "sequential",
      profileRoleIds: ["reviewer"],
      materializedRoleIds: ["reviewer"],
    },
    extend_scope: {
      id: "extend_scope",
      executionMode: "sequential",
      profileRoleIds: ["reviewer"],
      materializedRoleIds: ["reviewer"],
    },
    read: {
      id: "read",
      executionMode: "sequential",
      profileRoleIds: ["kernel", "reviewer"],
      materializedRoleIds: ["kernel", "reviewer"],
    },
    inspect_directory: {
      id: "inspect_directory",
      executionMode: "sequential",
      profileRoleIds: ["reviewer"],
      materializedRoleIds: ["reviewer"],
    },
    check_completion: {
      id: "check_completion",
      executionMode: "sequential",
      profileRoleIds: ["reviewer"],
      materializedRoleIds: ["reviewer"],
    },
    abandon_work: {
      id: "abandon_work",
      executionMode: "sequential",
      profileRoleIds: ["reviewer"],
      materializedRoleIds: ["reviewer"],
    },
    write: {
      id: "write",
      executionMode: "sequential",
      profileRoleIds: ["kernel"],
      materializedRoleIds: ["kernel"],
    },
  },
  practices: {
    "workspace-operations": {
      id: "workspace-operations",
      version: 1,
      supportedRoleIds: ["kernel"],
      methodologySkillId: "workspace-operations-v1",
    },
    review: {
      id: "review",
      version: 2,
      supportedRoleIds: ["reviewer"],
      methodologySkillId: "review-v2",
      completionSchemaId: "review-claim-v2",
      checkpointIds: REVIEW_CHECKPOINT_IDS,
    },
  },
  gatePolicies: {
    "workspace-tools-v1": {
      id: "workspace-tools-v1",
      supportedRoleIds: ["kernel"],
      toolIds: ["read", "write"],
    },
    "reviewer-v2": {
      id: "reviewer-v2",
      supportedRoleIds: ["reviewer"],
      toolIds: ["start_work", "extend_scope", "read", "inspect_directory", "check_completion", "abandon_work"],
    },
  },
  roleSkills: {
    "kernel-v1": {
      id: "kernel-v1",
      supportedRoleIds: ["kernel"],
      relativePath: "roles/kernel/role.md",
      digest: "2913a8592c6f472df4a13b58645fd585320ee1365c089d0fa843d7718568d159",
      maxBytes: 16 * 1024,
    },
    "reviewer-v2": {
      id: "reviewer-v2",
      supportedRoleIds: ["reviewer"],
      relativePath: "roles/reviewer/role.md",
      digest: "4696719ce280106cb66da7968c6a472edcb271187322e7250e87583e88d4c776",
      maxBytes: 16 * 1024,
    },
  },
  methodologySkills: {
    "workspace-operations-v1": {
      id: "workspace-operations-v1",
      supportedPracticeIds: ["workspace-operations"],
      relativePath: "practices/workspace-operations/methodology.md",
      digest: "21b3920ff57bfcf699a51eb2501d849d79983a192829b98cebb86c04fc566ba5",
      maxBytes: 32 * 1024,
    },
    "review-v2": {
      id: "review-v2",
      supportedPracticeIds: ["review"],
      relativePath: "practices/review/methodology.md",
      digest: "a434fde636e5d847298fa9b4ec71c596a965defe24df27ead0640d3d0e73684b",
      maxBytes: 32 * 1024,
    },
  },
});

export function closedRoleRegistries() {
  return registries;
}

export function registryEntry(registryName, id) {
  const registry = registries[registryName];
  if (!registry || !Object.hasOwn(registry, id)) return undefined;
  return registry[id];
}
