import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  isControlProfile,
  isMemberConfig,
  isTeamConfig,
  isTeamRouteBinding,
} from "./coordination-store.mjs";
import { createRemoteCoordinationStore, createRemoteOpenClawLeaderAdmissionHook } from "./coordination-control-client.mjs";

const MAX_BINDING_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;

function requiredIdentifier(value, name) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`${name} is missing or invalid`);
  return value;
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function assertKeys(value, allowed, name) {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${name} contains unknown fields`);
}

function validateBindings(value) {
  const root = assertObject(value, "Leader runtime binding");
  assertKeys(root, new Set(["team", "route", "profile", "leaderMember", "members"]), "Leader runtime binding");
  const team = root.team;
  const route = root.route;
  const profile = root.profile;
  const leaderMember = root.leaderMember;
  const members = root.members;
  if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile) || !isMemberConfig(leaderMember)) throw new Error("Leader runtime binding records are invalid");
  if (!Array.isArray(members) || members.length !== team.memberIds.length || members.some((member) => !isMemberConfig(member))) throw new Error("Leader runtime binding member list is invalid");
  const memberIds = new Set(members.map((member) => member.memberId));
  if (memberIds.size !== members.length || team.memberIds.some((memberId) => !memberIds.has(memberId))) throw new Error("Leader runtime binding member list does not match TeamConfig");
  if (route.teamId !== team.teamId || team.controlProfileId !== profile.profileId || leaderMember.teamId !== team.teamId || leaderMember.controlProfileId !== profile.profileId || leaderMember.memberId !== team.leaderMemberId || !leaderMember.enabled) throw new Error("Leader runtime binding references disagree");
  return Object.freeze({ team, route, profile, leaderMember, members: Object.freeze([...members]) });
}

/** Read only a deployment-owned, credential-free binding file. */
export async function readLeaderRuntimeBinding(filePath) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) throw new TypeError("Leader runtime binding file must be an absolute path");
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_BINDING_BYTES) throw new Error("Leader runtime binding file is invalid");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Leader runtime binding file permissions are too broad");
  let value;
  try { value = JSON.parse(await readFile(filePath, "utf8")); } catch { throw new Error("Leader runtime binding file is not valid JSON"); }
  return validateBindings(value);
}

/**
 * Compose the deployment-owned remote pieces once at Worker startup. The
 * token is deliberately an argument/secret-manager value and never part of
 * the binding file or returned metadata.
 */
export async function createLeaderRuntimeBinding({ filePath, controlEndpoint, controlToken, channel, fetchImpl = globalThis.fetch } = {}) {
  const binding = await readLeaderRuntimeBinding(filePath);
  const coordinationStore = createRemoteCoordinationStore({ endpoint: controlEndpoint, token: controlToken, fetchImpl });
  const leaderIngress = createRemoteOpenClawLeaderAdmissionHook({ channel, endpoint: controlEndpoint, token: controlToken, fetchImpl });
  return Object.freeze({ ...binding, coordinationStore, leaderIngress });
}

export { requiredIdentifier };

