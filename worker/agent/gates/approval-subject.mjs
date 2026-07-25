export function assertApprovalSubject(checkpoint, actorId) {
  if (typeof actorId !== "string" || actorId === "") {
    throw new Error("Approval subject is unavailable");
  }
  if (typeof checkpoint?.requestedBy !== "string" || checkpoint.requestedBy === "") {
    throw new Error("Approval requester is unavailable");
  }
  if (checkpoint.requestedBy !== actorId) {
    throw new Error("Approval subject is not authorized for this operation");
  }
  return actorId;
}
