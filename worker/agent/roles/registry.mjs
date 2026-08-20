// Historical v0.4.1 closed registries retained only for non-active Runner and
// release regression tests. The product plugin and tg-worker Agent path must
// not import this module; M1/M2 use agent-packages/ and product Skills.
//
// A RoleProfile selects one authenticated responsibility identity, one SOUL,
// and an allowlisted set of same-authority Skills. The registries contain no
// role-neutral durable state: WorkRun is the state
// boundary and TeamPlaybook owns professional sequencing.

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const registries = deepFreeze({
  roles: {
    // Kernel is an internal default-image profile for the generic workspace
    // smoke. The Team's five responsibility roles are leader + four
    // professionals below; kernel is never a Team assignment.
    kernel: {
      id: "kernel",
      title: "Tiangong Core",
      runtimeKind: "core",
      soulId: "kernel-soul-v1",
      skillIds: ["kernel-workspace-v1"],
      toolIds: ["read", "write"],
      gatePolicyId: "workspace-tools-v1",
      profileDigest: "178f84bc47ee9964a724ba3db284f0d4c2b031ad9ede3660d3b1e288699aee11",
    },
    leader: {
      id: "leader",
      title: "Tiangong Team Leader",
      runtimeKind: "leader",
      soulId: "leader-soul-v1",
      skillIds: ["leader-coordination-v1"],
      toolIds: ["team_create_project", "team_dispatch_task", "team_check_result", "team_decide_task", "team_report"],
      gatePolicyId: "leader-tools-v1",
      profileDigest: "cab7c062e9ded86c0fba465ad73b32a57feaa6e7c2a380ac885654f97efdefff",
    },
    designer: {
      id: "designer",
      title: "Tiangong Designer",
      runtimeKind: "member",
      soulId: "designer-soul-v1",
      skillIds: ["designer-design-delivery-v1"],
      toolIds: ["team_resolve_task", "team_submit_result"],
      gatePolicyId: "professional-tools-v1",
      profileDigest: "232ef7080049e1fae32926caa5bb23c9b758cfc09f7afe83bd3b489e71e5c6b1",
    },
    implementor: {
      id: "implementor",
      title: "Tiangong Implementor",
      runtimeKind: "member",
      soulId: "implementor-soul-v1",
      skillIds: ["implementor-controlled-implementation-v1"],
      toolIds: ["team_resolve_task", "run_command", "team_submit_result"],
      gatePolicyId: "implementor-tools-v1",
      profileDigest: "ae8dde5f53569dca425b0b050f524aae180c83e6a292c6dfd6311dc77671687e",
    },
    assessor: {
      id: "assessor",
      title: "Tiangong Assessor",
      runtimeKind: "member",
      soulId: "assessor-soul-v1",
      skillIds: ["assessor-independent-assessment-v1"],
      toolIds: ["team_resolve_task", "run_test_command", "team_submit_result"],
      gatePolicyId: "assessor-tools-v1",
      profileDigest: "7894ab0eafc52c4a1620327e9cd1e91c74967387acdc3ad5d4761571284add76",
    },
    operator: {
      id: "operator",
      title: "Tiangong Operator",
      runtimeKind: "member",
      soulId: "operator-soul-v1",
      skillIds: ["operator-controlled-release-v1"],
      toolIds: ["team_resolve_task", "deploy_release", "team_submit_result"],
      gatePolicyId: "deployment-tools-v1",
      profileDigest: "42f35bddb4183842c148d4c348506ac5494863646c04b172ea942ceafa2d3ffc",
    },
  },
  tools: {
    read: {
      id: "read",
      executionMode: "sequential",
      profileRoleIds: ["kernel"],
      materializedRoleIds: ["kernel"],
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
    },
  },
  gatePolicies: {
    "workspace-tools-v1": {
      id: "workspace-tools-v1",
      supportedRoleIds: ["kernel"],
      toolIds: ["read", "write"],
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
    "deployment-tools-v1": {
      id: "deployment-tools-v1",
      supportedRoleIds: ["operator"],
      toolIds: ["team_resolve_task", "deploy_release", "team_submit_result"],
    },
  },
  souls: {
    "kernel-soul-v1": {
      id: "kernel-soul-v1",
      supportedRoleIds: ["kernel"],
      relativePath: "roles/kernel/SOUL.md",
      digest: "2913a8592c6f472df4a13b58645fd585320ee1365c089d0fa843d7718568d159",
      maxBytes: 16 * 1024,
    },
    "leader-soul-v1": {
      id: "leader-soul-v1",
      supportedRoleIds: ["leader"],
      relativePath: "roles/leader/SOUL.md",
      digest: "1e023bd9aa0af90ce044036b81b0976391d03a2831e9578ec00b0ef860a000cb",
      maxBytes: 16 * 1024,
    },
    "designer-soul-v1": {
      id: "designer-soul-v1",
      supportedRoleIds: ["designer"],
      relativePath: "roles/designer/SOUL.md",
      digest: "360ff77f2da57456ff9510720176e61db03a0b36de3eeb0f9b1338f28296a3f9",
      maxBytes: 16 * 1024,
    },
    "implementor-soul-v1": {
      id: "implementor-soul-v1",
      supportedRoleIds: ["implementor"],
      relativePath: "roles/implementor/SOUL.md",
      digest: "2a206df223179f6557616877e4a96ac0e405b47606f7daee8d5b13f8e8dc7f45",
      maxBytes: 16 * 1024,
    },
    "assessor-soul-v1": {
      id: "assessor-soul-v1",
      supportedRoleIds: ["assessor"],
      relativePath: "roles/assessor/SOUL.md",
      digest: "78837abf583f8dcdac3eb3edfc034aff35e9589a9b150915e01a9b861fb9c89c",
      maxBytes: 16 * 1024,
    },
    "operator-soul-v1": {
      id: "operator-soul-v1",
      supportedRoleIds: ["operator"],
      relativePath: "roles/operator/SOUL.md",
      digest: "921c2f9ce130fa49c9dbdeaad025f363bb685b6abde11cc3dddc3ce50e416505",
      maxBytes: 16 * 1024,
    },
  },
  skills: {
    "kernel-workspace-v1": {
      id: "kernel-workspace-v1",
      supportedRoleIds: ["kernel"],
      relativePath: "legacy/skills/kernel/workspace.md",
      digest: "b386903cc1466ddc536887c3156383aba91853a5040e86aaa627d62b5ec7568f",
      maxBytes: 16 * 1024,
    },
    "leader-coordination-v1": {
      id: "leader-coordination-v1",
      supportedRoleIds: ["leader"],
      relativePath: "legacy/skills/leader/coordination.md",
      digest: "40bb638aca7292fe5da65ac65071f6d2e70067ac7a50daf2abd7318704a99f34",
      maxBytes: 16 * 1024,
    },
    "designer-design-delivery-v1": {
      id: "designer-design-delivery-v1",
      supportedRoleIds: ["designer"],
      relativePath: "legacy/skills/designer/design-delivery.md",
      digest: "42b3946603971a7ea5d5a6d0fd596698441d06ac149c311c9fe5b4d5832bc477",
      maxBytes: 16 * 1024,
    },
    "implementor-controlled-implementation-v1": {
      id: "implementor-controlled-implementation-v1",
      supportedRoleIds: ["implementor"],
      relativePath: "legacy/skills/implementor/controlled-implementation.md",
      digest: "70e3d641f48bb5d509eb9d504bec3174fff58c2de2a8a97f7078e2a5f5abb411",
      maxBytes: 16 * 1024,
    },
    "assessor-independent-assessment-v1": {
      id: "assessor-independent-assessment-v1",
      supportedRoleIds: ["assessor"],
      relativePath: "legacy/skills/assessor/independent-assessment.md",
      digest: "9cc86efdee42e8d9a72f93dde19034887ab9fff0030875dcda0892e22d29183e",
      maxBytes: 16 * 1024,
    },
    "operator-controlled-release-v1": {
      id: "operator-controlled-release-v1",
      supportedRoleIds: ["operator"],
      relativePath: "legacy/skills/operator/controlled-release.md",
      digest: "7dff663862ff447be965a54f793a3cd0233915bc533cad2431536bc695c4cc8c",
      maxBytes: 16 * 1024,
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
