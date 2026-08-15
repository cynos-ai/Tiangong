let tail = Promise.resolve();

export async function acquirePostgresTestLock() {
  const previous = tail;
  let release;
  tail = new Promise((resolve) => { release = resolve; });
  await previous;
  return release;
}

