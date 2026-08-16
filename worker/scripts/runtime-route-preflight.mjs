import { runtimeRouteFromEnvironment } from "../agent/runtime-routing.mjs";

const route = runtimeRouteFromEnvironment(process.env);
process.stdout.write(`tiangong_runtime_route=pass role=${route.roleId} runtime=${route.runtime} fallback=${route.fallback} digest=${route.routeDigest}\n`);
