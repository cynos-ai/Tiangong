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
      targetKindIds: ["file", "directory_snapshot", "commit", "git_diff"],
      toolIds: ["start_work", "extend_scope", "read", "inspect_directory", "inspect_repository", "check_completion", "abandon_work"],
      gatePolicyId: "reviewer-v2",
      roleSkillId: "reviewer-v2",
      profileDigest: "fbfb76ec336cc841e39cf42d028aa7f1883dfb5a7e546692da18c85648d928cd",
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
    commit: {
      id: "commit",
      materializedRoleIds: ["reviewer"],
      captureVersion: "review-commit-snapshot-v1",
    },
    git_diff: {
      id: "git_diff",
      materializedRoleIds: ["reviewer"],
      captureVersion: "review-git-diff-snapshot-v1",
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
    inspect_repository: {
      id: "inspect_repository",
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
      toolIds: ["start_work", "extend_scope", "read", "inspect_directory", "inspect_repository", "check_completion", "abandon_work"],
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
      digest: "8226e4884d33ab598ebdd435509756d084d120817088d5573f6208bbbe410e07",
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
      digest: "82a388f2172a7f845efbde83479776cd24e9100b841f116591156b4ad1ce12cc",
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
