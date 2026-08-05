// The versioned TeamPlaybook package owns the deterministic transition policy.
// Runtime code imports this stable bridge so local tests and the Worker image
// execute the same package bytes that are locked and distributed.
export * from "../../../team-playbooks/software-change-delivery/transition-policy.mjs";
