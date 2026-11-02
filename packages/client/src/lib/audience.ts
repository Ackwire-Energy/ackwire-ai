import type { TFunction } from "i18next";
import type { Agent, AgentAudience, AudienceMode, OrgSummary } from "../api/types";
import { joinNames } from "./format";
import { agentGrammar } from "./grammar";
import { can } from "./permissions";

/** The agent's audience; absent = everyone (older servers). */
export function audienceOf(agent: Agent): Required<AgentAudience> {
  if (agent.audience)
    return {
      mode: agent.audience.mode,
      userIds: agent.audience.userIds ?? [],
      roleIds: agent.audience.roleIds ?? [],
      consultable: agent.audience.consultable ?? true,
    };
  return { mode: agent.audienceMode ?? "everyone", userIds: [], roleIds: [], consultable: true };
}

export const modeOf = (agent: Agent): AudienceMode => agent.audience?.mode ?? agent.audienceMode ?? "everyone";

/**
 * Whether its audience lets `userId` talk to the agent (the server's `canTalkTo`, without `talk_to_agents`): its
 * owner, everyone, one of its people, or holding one of its roles (`roleIds`: theirs, from the directory). A people
 * list the directory didn't send, or roles picked when theirs aren't known, say yes (don't warn on a guess).
 */
export function audienceAdmits(agent: Agent, userId: string, roleIds?: readonly string[]): boolean {
  if (agent.ownerUserId === userId) return true;
  const mode = modeOf(agent);
  if (mode !== "people") return mode === "everyone";
  const a = audienceOf(agent);
  if (!agent.audience || a.userIds.includes(userId)) return true;
  return roleIds ? a.roleIds.some((id) => roleIds.includes(id)) : a.roleIds.length > 0;
}

/** Its audience with `userId` let in; null when its people list wasn't sent (saving would drop them). */
export function audienceWith(agent: Agent, userId: string): AgentAudience | null {
  if (modeOf(agent) === "people" && !agent.audience) return null;
  const a = audienceOf(agent);
  const people = a.mode === "people";
  return {
    mode: "people",
    userIds: [...new Set([...(people ? a.userIds : []), userId])],
    roleIds: people ? a.roleIds : [],
  };
}

/** Whether I can talk to it (the server's `canTalk`; absent = yes). */
export const canTalk = (agent: Pick<Agent, "canTalk"> | undefined) => agent?.canTalk !== false;

/**
 * Whether my lists and pickers show the agent: every agent for who manages agents, who arrange the team (the lock
 * says who it answers), only the ones that answer me for everyone else. From the server's `canTalk` (the agent's
 * audience and `talk_to_agents`), so a later limit per person reaches every list unchanged.
 */
export const listsAgent = (org: OrgSummary | null | undefined, agent: Pick<Agent, "canTalk"> | undefined) =>
  can(org, "manage_agents") || canTalk(agent);

/** Whether `to` lets someone talk to the agent whom `from` didn't; its owner always can (same rule as the backend). */
export function audienceWidens(from: AgentAudience, to: AgentAudience, ownerUserId: string | null): boolean {
  if (to.mode === "owner" || from.mode === "everyone") return false;
  if (to.mode === "everyone" || (to.consultable !== false && from.consultable === false)) return true;
  const people = new Set(from.mode === "people" ? from.userIds : []);
  const roles = new Set(from.mode === "people" ? (from.roleIds ?? []) : []);
  return (
    to.userIds.some((id) => id !== ownerUserId && !people.has(id)) || (to.roleIds ?? []).some((id) => !roles.has(id))
  );
}

/** Someone besides its owner can talk to the agent. */
export const answersOthers = (a: AgentAudience, ownerUserId: string | null) =>
  audienceWidens({ mode: "owner", userIds: [] }, a, ownerUserId);

/** Only the agent's owner and who manages agents change who talks to it (same rule as the backend). */
export const canEditAudience = (org: OrgSummary | undefined, agent: Agent, myUserId: string) =>
  can(org, "manage_agents") || (agent.ownerUserId != null && agent.ownerUserId === myUserId);

/** "Pessoal" (only the owner) or "Restrito" (some people); nothing for everyone. */
export function audienceChip(t: TFunction, agent: Agent): string | null {
  const mode = modeOf(agent);
  if (mode === "owner") return t("audience.chip.owner");
  if (mode === "people") return t("audience.chip.people");
  return null;
}

type NameOf = (id: string) => string | undefined;

/** Who it answers: its roles, then its owner and its people (only the names we know). */
function answered(agent: Agent, nameOf: NameOf, roleName: NameOf) {
  const a = audienceOf(agent);
  const people = a.mode === "people";
  const ids = [...new Set([...(agent.ownerUserId ? [agent.ownerUserId] : []), ...(people ? a.userIds : [])])];
  const known = (n: string | undefined): n is string => Boolean(n);
  return { roles: (people ? a.roleIds : []).map(roleName).filter(known), people: ids.map(nameOf).filter(known) };
}

/** Who it answers, roles first, then the owner: ["Suporte", "Walter", "Ana"] (only the names we know). */
export function audienceNames(agent: Agent, nameOf: NameOf, roleName: NameOf = () => undefined): string[] {
  const { roles, people } = answered(agent, nameOf, roleName);
  return [...roles, ...people];
}

/** "O Theo só responde a Suporte e Walter." / "… a algumas pessoas." / "" for everyone. */
export function audienceNotice(t: TFunction, agent: Agent, nameOf: NameOf, roleName?: NameOf): string {
  const mode = modeOf(agent);
  if (mode === "everyone") return "";
  const g = agentGrammar(t, agent.name);
  // From the directory list (mode only, no user ids): don't guess names.
  if (mode === "people" && !agent.audience) return t("audience.notice.some", g);
  const names = audienceNames(agent, nameOf, roleName);
  if (names.length === 0) return t("audience.notice.nobody", g);
  return t("audience.notice.only", { ...g, names: joinNames(names, t("newAgent.and")) });
}

/** The profile summary: "Todos do workspace", "Suporte, Tecnologia e mais 2 pessoas", "Só Walter". */
export function audienceSummary(t: TFunction, agent: Agent, nameOf: NameOf, roleName: NameOf = () => undefined) {
  const a = audienceOf(agent);
  const owner = agent.ownerUserId ? nameOf(agent.ownerUserId) : undefined;
  if (a.mode === "everyone") return t("audience.summary.everyone");
  if (a.mode === "owner") return owner ? t("audience.summary.owner", { name: owner }) : t("audience.summary.nobody");
  const { roles, people } = answered(agent, nameOf, roleName);
  const names = [...roles, ...people];
  if (names.length === 0) return t("audience.summary.someone");
  if (names.length <= 3) return t("audience.summary.people", { names: joinNames(names, t("newAgent.and")) });
  const shown = names.slice(0, 2).join(", ");
  const count = names.length - 2;
  // Only people left over: "e mais 2 pessoas".
  if (roles.length <= 2) return t("audience.summary.manyPeople", { names: shown, count });
  return t("audience.summary.many", { names: shown, count });
}
