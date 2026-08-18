import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { createWriteToolDefinition } from "./openclaw-tool-definitions.mjs";

import { resolveWorkspacePath } from "./operations.mjs";

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path, content) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.tiangong-write-${process.pid}-${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function createConstrainedWrite({ workspaceDir, rollbackDir }) {
  if (!rollbackDir) throw new TypeError("rollbackDir is required");
  const definition = createWriteToolDefinition(workspaceDir, {
    operations: {
      async mkdir(path) {
        await resolveWorkspacePath(workspaceDir, path);
        await mkdir(path, { recursive: true, mode: 0o700 });
        await resolveWorkspacePath(workspaceDir, path);
      },
      async writeFile(path, content) {
        const target = await resolveWorkspacePath(workspaceDir, path);
        await atomicWrite(target.absolutePath, content);
      },
    },
  });

  const lifecycle = {
    async prepare({ idempotencyKey, operation }) {
      const target = await resolveWorkspacePath(workspaceDir, operation.target);
      const directory = join(rollbackDir, idempotencyKey);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const backupPath = join(directory, "previous-content");
      let existed = false;
      try {
        const stat = await lstat(target.absolutePath);
        if (!stat.isFile()) throw new Error("Write target must be a regular file or not exist");
        await writeFile(backupPath, await readFile(target.absolutePath), { mode: 0o600 });
        await writeFile(join(directory, "metadata.json"), "{\"existed\":true}\n", { mode: 0o600 });
        existed = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await writeFile(join(directory, "metadata.json"), "{\"existed\":false}\n", { mode: 0o600 });
      }
      return { directory, backupPath, targetPath: target.absolutePath, existed };
    },

    async rollback(snapshot) {
      if (!snapshot) return;
      if (snapshot.existed) {
        await atomicWrite(snapshot.targetPath, await readFile(snapshot.backupPath));
      } else {
        await unlink(snapshot.targetPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        await syncDirectory(dirname(snapshot.targetPath));
      }
    },

    async commit(snapshot) {
      if (snapshot) await rm(snapshot.directory, { recursive: true, force: true });
    },
  };

  return { definition, lifecycle };
}
