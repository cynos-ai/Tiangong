const REVIEW_CHECKPOINT_IDS = [
  "claim-schema-valid",
  "criteria-covered",
  "scope-matches-final",
  "scope-fully-read",
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
      toolIds: ["start_work", "extend_scope", "read", "check_completion", "abandon_work"],
      gatePolicyId: "reviewer-v1",
      roleSkillId: "reviewer-v1",
      profileDigest: "636a466beb58788da2786d1eabcad4a8479006b4f2e6df46fb1b648bc1ceeaf7",
    },
  },
  tools: {
    start_work: {
      id: "start_work",
      executionMode: "sequential",
      profileRoleIds: ["reviewer"],
      materializedRoleIds: [],
    },
    extend_scope: {
      id: "extend_scope",
      executionMode: "sequential",
      profileRoleIds: ["reviewer"],
      materializedRoleIds: [],
    },
    read: {
      id: "read",
      executionMode: "sequential",
      profileRoleIds: ["kernel", "reviewer"],
      materializedRoleIds: ["kernel"],
    },
    check_completion: {
      id: "check_completion",
      executionMode: "sequential",
      profileRoleIds: ["reviewer"],
      materializedRoleIds: [],
    },
    abandon_work: {
      id: "abandon_work",
      executionMode: "sequential",
      profileRoleIds: ["reviewer"],
      materializedRoleIds: [],
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
      version: 1,
      supportedRoleIds: ["reviewer"],
      methodologySkillId: "review-v1",
      completionSchemaId: "review-claim-v1",
      checkpointIds: REVIEW_CHECKPOINT_IDS,
    },
  },
  gatePolicies: {
    "workspace-tools-v1": {
      id: "workspace-tools-v1",
      supportedRoleIds: ["kernel"],
      toolIds: ["read", "write"],
    },
    "reviewer-v1": {
      id: "reviewer-v1",
      supportedRoleIds: ["reviewer"],
      toolIds: ["start_work", "extend_scope", "read", "check_completion", "abandon_work"],
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
    "reviewer-v1": {
      id: "reviewer-v1",
      supportedRoleIds: ["reviewer"],
      relativePath: "roles/reviewer/role.md",
      digest: "6c6b566be09d6a0abc15d36f16bb59d709a4277ed506dfc296e7ec5c1ea47b9f",
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
    "review-v1": {
      id: "review-v1",
      supportedPracticeIds: ["review"],
      relativePath: "practices/review/methodology.md",
      digest: "630e948158f5da71fb7f0b61d35d9d64f91ae32563b85cbe4c475e395db568a1",
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
