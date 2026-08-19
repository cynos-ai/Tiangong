import { readFile } from "node:fs/promises";

import { loadAgentPackages } from "../worker/agent/packages/loader.mjs";
import { loadInstalledSkills } from "../worker/agent/skills/catalog.mjs";

const workers = await readFile(new URL("../demo/fixtures/workers.yaml", import.meta.url), "utf8");
const team = await readFile(new URL("../demo/fixtures/team.yaml", import.meta.url), "utf8");
const demoScript = await readFile(new URL("./tiangong-demo.sh", import.meta.url), "utf8");
const responsibilities = ["leader", "architect", "challenger", "developer", "reviewer", "tester"];
for (const responsibility of responsibilities) {
  if (!workers.includes(`tiangong-demo-${responsibility}`) || !team.includes(`tiangong-demo-${responsibility}`)) throw new Error(`demo member missing: ${responsibility}`);
}
const images = [...workers.matchAll(/^\s*image:\s*(\S+)\s*$/gmu)].map((match) => match[1]);
if (images.length !== responsibilities.length || images.some((image) => image !== "tg-worker:dev")) throw new Error("demo must use only generic tg-worker");
if (/tiangong-worker-(?:leader|designer|implementor|assessor|operator)/u.test(workers)) throw new Error("role-specific image remains in demo");
if (!workers.includes("model: deepseek-v4-flash") || !workers.includes("model: deepseek-chat")) throw new Error("demo runtime/model baseline is incomplete");
const [{ packages }, { skills }] = await Promise.all([loadAgentPackages(), loadInstalledSkills()]);
if (packages.length !== responsibilities.length || packages.some((agent) => !responsibilities.includes(agent.responsibility))) throw new Error("demo Agent packages are incomplete");
if (skills.length !== 6) throw new Error("demo product Skills are incomplete");
if (!demoScript.includes("TIANGONG_DEMO_M1_RUNTIME_READY") || !demoScript.includes("M1 Agent package and Coordination bindings are not proven")) throw new Error("demo send path must fail closed without M1 deployment bindings");
process.stdout.write(`${JSON.stringify({ status: "pass", image: "tg-worker:dev", responsibilities, agentPackages: packages.length, productSkills: skills.length })}\n`);
