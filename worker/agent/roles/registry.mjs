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
    leader: {
      id: "leader",
      title: "Tiangong Team Leader",
      practiceIds: [],
      toolIds: ["team_create_project", "team_dispatch_task", "team_check_result", "team_decide_task", "team_report"],
      gatePolicyId: "leader-tools-v1",
      roleSkillId: "leader-v1",
      profileDigest: "f580eae443496ed7a3e50575e7157d5563a491b53d9d07ea2bd2f33032272fac",
    },
    designer: {
      id: "designer", title: "Tiangong Designer", practiceIds: [],
      toolIds: ["team_resolve_task", "team_submit_result"], gatePolicyId: "professional-tools-v1",
      roleSkillId: "designer-v1", profileDigest: "aad09452ef5976eeee24a1c976eeae93064ed01bb84ba8bc85588586b361e3e6",
    },
    implementor: {
      id: "implementor", title: "Tiangong Implementor", practiceIds: [],
      toolIds: ["team_resolve_task", "run_command", "team_submit_result"], gatePolicyId: "implementor-tools-v1",
      roleSkillId: "implementor-v1", profileDigest: "e51507408f2fa6546163bff1aeb42fc37e908847207bbceca108b2314ca28d0a",
    },
    assessor: {
      id: "assessor", title: "Tiangong Assessor", practiceIds: [],
      toolIds: ["team_resolve_task", "run_test_command", "team_submit_result"], gatePolicyId: "assessor-tools-v1",
      roleSkillId: "assessor-v1", profileDigest: "9f3a2da2bc39ca35f99e4b0f50708714bfcd11ad1990ca5784d948d5dd245283",
    },
    operator: {
      id: "operator", title: "Tiangong Operator", practiceIds: [],
      toolIds: ["team_resolve_task", "deploy_release", "team_submit_result"], gatePolicyId: "deployment-tools-v1",
      roleSkillId: "operator-v1", profileDigest: "43f05e5a5b4797fccb329e9bc6990a088dec5704016b8a2a4f701c141982d143",
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
    team_create_project: {
      id: "team_create_project",
      executionMode: "sequential",
      profileRoleIds: ["leader"],
      materializedRoleIds: ["leader"],
    },
    team_dispatch_task: {
      id: "team_dispatch_task",
      executionMode: "sequential",
      profileRoleIds: ["leader"],
      materializedRoleIds: ["leader"],
    },
    team_check_result: {
      id: "team_check_result",
      executionMode: "sequential",
      profileRoleIds: ["leader"],
      materializedRoleIds: ["leader"],
    },
    team_decide_task: {
      id: "team_decide_task",
      executionMode: "sequential",
      profileRoleIds: ["leader"],
      materializedRoleIds: ["leader"],
    },
    team_report: {
      id: "team_report",
      executionMode: "sequential",
      profileRoleIds: ["leader"],
      materializedRoleIds: ["leader"],
    },
    team_resolve_task: {
      id: "team_resolve_task",
      executionMode: "sequential",
      profileRoleIds: ["designer", "implementor", "assessor", "operator"],
      materializedRoleIds: ["designer", "implementor", "assessor", "operator"],
    },
    run_command: {
      id: "run_command",
      executionMode: "sequential",
      profileRoleIds: ["implementor"],
      materializedRoleIds: ["implementor"],
    },
    run_test_command: {
      id: "run_test_command",
      executionMode: "sequential",
      profileRoleIds: ["assessor"],
      materializedRoleIds: ["assessor"],
    },
    deploy_release: {
      id: "deploy_release",
      executionMode: "sequential",
      profileRoleIds: ["operator"],
      materializedRoleIds: ["operator"],
    },
    team_submit_result: {
      id: "team_submit_result",
      executionMode: "sequential",
      profileRoleIds: ["designer", "implementor", "assessor", "operator"],
      materializedRoleIds: ["designer", "implementor", "assessor", "operator"],
    }
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
    "leader-tools-v1": {
      id: "leader-tools-v1",
      supportedRoleIds: ["leader"],
      toolIds: ["team_create_project", "team_dispatch_task", "team_check_result", "team_decide_task", "team_report"],
    },
    "professional-tools-v1": {
      id: "professional-tools-v1",
      supportedRoleIds: ["designer"],
      toolIds: ["team_resolve_task", "team_submit_result"],
    },
    "deployment-tools-v1": {
      id: "deployment-tools-v1",
      supportedRoleIds: ["operator"],
      toolIds: ["team_resolve_task", "deploy_release", "team_submit_result"],
    },
    "implementor-tools-v1": {
      id: "implementor-tools-v1",
      supportedRoleIds: ["implementor"],
      toolIds: ["team_resolve_task", "run_command", "team_submit_result"],
    },
    "assessor-tools-v1": {
      id: "assessor-tools-v1",
      supportedRoleIds: ["assessor"],
      toolIds: ["team_resolve_task", "run_test_command", "team_submit_result"],
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
    "leader-v1": {
      id: "leader-v1",
      supportedRoleIds: ["leader"],
      relativePath: "roles/leader/role.md",
      digest: "1e023bd9aa0af90ce044036b81b0976391d03a2831e9578ec00b0ef860a000cb",
      maxBytes: 16 * 1024,
    },
    "designer-v1": {
      id: "designer-v1", supportedRoleIds: ["designer"], relativePath: "roles/designer/role.md",
      digest: "360ff77f2da57456ff9510720176e61db03a0b36de3eeb0f9b1338f28296a3f9", maxBytes: 16 * 1024,
    },
    "implementor-v1": {
      id: "implementor-v1", supportedRoleIds: ["implementor"], relativePath: "roles/implementor/role.md",
      digest: "3099bfc6e6d6c1cb8d215b025f54e4d1028e2e8b419e5e9aba20483e7d3c6561", maxBytes: 16 * 1024,
    },
    "assessor-v1": {
      id: "assessor-v1", supportedRoleIds: ["assessor"], relativePath: "roles/assessor/role.md",
      digest: "09eb73c76073e0668c790f1be89cc2a23786825455c0e77d417ccf5a5a53f8d3", maxBytes: 16 * 1024,
    },
    "operator-v1": {
      id: "operator-v1", supportedRoleIds: ["operator"], relativePath: "roles/operator/role.md",
      digest: "fee7b721bb069e4edc5ea982f833489b8f822ae2c203825794e2fdad22c5cce3", maxBytes: 16 * 1024,
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
