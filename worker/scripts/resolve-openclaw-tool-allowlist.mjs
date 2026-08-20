import { resolveAgentRuntimeFromEnvironment } from "../agent/packages/loader.mjs";
import { topLevelToolsForGroups } from "../agent/packages/tool-groups.mjs";

const runtime = await resolveAgentRuntimeFromEnvironment(process.env);
process.stdout.write(`${JSON.stringify(topLevelToolsForGroups(runtime.agentPackage.toolGroups))}\n`);
