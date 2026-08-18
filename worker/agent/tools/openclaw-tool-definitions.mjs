import { access, constants, mkdir, readFile, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";

import { resolveWorkspacePath } from "./operations.mjs";

const MAX_LINES = 2_000;
const MAX_BYTES = 50 * 1024;

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative to the workspace)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
}, { additionalProperties: false });

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative to the workspace)" }),
  content: Type.String({ description: "Content to write to the file" }),
}, { additionalProperties: false });

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Operation aborted");
}

function truncateText(text, { offset, limit }) {
  const lines = text.split("\n");
  const start = offset === undefined ? 0 : Math.max(0, Math.floor(offset) - 1);
  if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
  const requestedEnd = limit === undefined ? lines.length : start + Math.max(0, Math.floor(limit));
  const end = Math.min(lines.length, requestedEnd, start + MAX_LINES);
  let content = lines.slice(start, end).join("\n");
  const byteLimit = MAX_BYTES;
  if (Buffer.byteLength(content, "utf8") > byteLimit) {
    content = Buffer.from(content, "utf8").subarray(0, byteLimit).toString("utf8");
  }
  const nextOffset = end < lines.length ? `\n\n[More lines available. Use offset=${end + 1} to continue.]` : "";
  return `${content}${nextOffset}`;
}

export function createReadToolDefinition(workspaceDir) {
  return {
    name: "read",
    label: "read",
    description: "Read a text file from the authorized workspace.",
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: readSchema,
    async execute(_toolCallId, { path, offset, limit }, signal) {
      throwIfAborted(signal);
      const target = await resolveWorkspacePath(workspaceDir, path);
      await access(target.absolutePath, constants.R_OK);
      throwIfAborted(signal);
      const content = truncateText((await readFile(target.absolutePath)).toString("utf8"), { offset, limit });
      throwIfAborted(signal);
      return { content: [{ type: "text", text: content }], details: { path: target.relativePath } };
    },
  };
}

export function createWriteToolDefinition(workspaceDir, { operations } = {}) {
  const writeFile = operations?.writeFile ?? ((path, content) => fsWriteFile(path, content, "utf8"));
  const makeDirectory = operations?.mkdir ?? ((path) => mkdir(path, { recursive: true, mode: 0o700 }));
  return {
    name: "write",
    label: "write",
    description: "Write content to a file in the authorized workspace.",
    promptSnippet: "Create or overwrite files",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    parameters: writeSchema,
    async execute(_toolCallId, { path, content }, signal) {
      throwIfAborted(signal);
      const target = await resolveWorkspacePath(workspaceDir, path);
      await makeDirectory(dirname(target.absolutePath));
      throwIfAborted(signal);
      await writeFile(target.absolutePath, content);
      throwIfAborted(signal);
      return {
        content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${target.relativePath}` }],
        details: { path: target.relativePath },
      };
    },
  };
}
