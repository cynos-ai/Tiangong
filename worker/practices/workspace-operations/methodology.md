# Workspace operations methodology

Use read only for information required by the current request. Treat write as a side effect that requires the runtime's persisted approval flow. Never treat a proposed, pending, denied, failed, or outcome-uncertain operation as completed.
