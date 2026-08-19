import { readFile } from "node:fs/promises";

const workers = await readFile(new URL("../demo/fixtures/workers.yaml", import.meta.url), "utf8");
const team = await readFile(new URL("../demo/fixtures/team.yaml", import.meta.url), "utf8");
const responsibilities = ["leader", "architect", "challenger", "developer", "reviewer", "tester"];
for (const responsibility of responsibilities) {
  if (!workers.includes(`tiangong-demo-${responsibility}`) || !team.includes(`tiangong-demo-${responsibility}`)) throw new Error(`demo member missing: ${responsibility}`);
}
const images = [...workers.matchAll(/^\s*image:\s*(\S+)\s*$/gmu)].map((match) => match[1]);
if (images.length !== responsibilities.length || images.some((image) => image !== "tg-worker:dev")) throw new Error("demo must use only generic tg-worker");
if (/tiangong-worker-(?:leader|designer|implementor|assessor|operator)/u.test(workers)) throw new Error("role-specific image remains in demo");
if (!workers.includes("model: deepseek-v4-flash") || !workers.includes("model: deepseek-chat")) throw new Error("demo runtime/model baseline is incomplete");
process.stdout.write(`${JSON.stringify({ status: "pass", image: "tg-worker:dev", responsibilities })}\n`);
