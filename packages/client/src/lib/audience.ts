import type { TFunction } from "i18next";
import type { Agent, AgentAudience, AudienceMode, Role } from "../api/types";
import { joinNames } from "./format";
import { agentGrammar } from "./grammar";
import { can } from "./permissions";

/** The agent's audience; absent = everyone (older servers). */
export function audienceOf(agent: Agent): AgentAudience {
  if (agent.audience) return { mode: agent.audience.mode, userIds: agent.audience.userIds ?? [] };
  return { mode: agent.audienceMode ?? "everyone", userIds: [] };
}

export const modeOf = (agent: Agent): AudienceMode => agent.audience?.mode ?? agent.audienceMode ?? "everyone";

/** Whether I can talk to it (the server's `canTalk`; absent = yes). */
export const canTalk = (agent: Pick<Agent, "canTalk"> | undefined) => agent?.canTalk !== false;

/**
 * Whether my lists and pickers show the agent: every agent for owners and admins, who arrange the team (the lock
 * says who it answers), only the ones that answer me for members. From the server's `canTalk`, so a later limit
 * per person reaches every list unchanged.
 */
export const listsAgent = (role: Role | undefined, agent: Pick<Agent, "canTalk"> | undefined) =>
  can(role, "manage_agents") || canTalk(agent);

/** Whether `to` lets someone talk to the agent whom `from` didn't; its owner always can (same rule as the backend). */
export function audienceWidens(from: AgentAudience, to: AgentAudience, ownerUserId: string | null): boolean {
  if (to.mode === "owner" || from.mode === "everyone") return false;
  if (to.mode === "everyone") return true;
  const before = new Set(from.mode === "people" ? from.userIds : []);
  return to.userIds.some((id) => id !== ownerUserId && !before.has(id));
}

/** Someone besides its owner can talk to the agent. */
export const answersOthers = (a: AgentAudience, ownerUserId: string | null) =>
  audienceWidens({ mode: "owner", userIds: [] }, a, ownerUserId);

/** Only the agent's owner and admins change who talks to it (same rule as the backend). */
export const canEditAudience = (role: Role | undefined, agent: Agent, myUserId: string) =>
  can(role, "manage_agents") || (agent.ownerUserId != null && agent.ownerUserId === myUserId);

/** "Pessoal" (only the owner) or "Restrito" (some people); nothing for everyone. */
export function audienceChip(t: TFunction, agent: Agent): string | null {
  const mode = modeOf(agent);
  if (mode === "owner") return t("audience.chip.owner");
  if (mode === "people") return t("audience.chip.people");
  return null;
}

/** Who it answers, owner first: ["Walter", "Ana"] (only the names we know). */
export function audienceNames(agent: Agent, nameOf: (userId: string) => string | undefined): string[] {
  const a = audienceOf(agent);
  const ids = [
    ...new Set([...(agent.ownerUserId ? [agent.ownerUserId] : []), ...(a.mode === "people" ? a.userIds : [])]),
  ];
  return ids.map(nameOf).filter((n): n is string => Boolean(n));
}

/** "O Theo só responde a Walter." / "… a algumas pessoas." / "" for everyone. */
export function audienceNotice(t: TFunction, agent: Agent, nameOf: (userId: string) => string | undefined): string {
  const mode = modeOf(agent);
  if (mode === "everyone") return "";
  const g = agentGrammar(t, agent.name);
  // From the directory list (mode only, no user ids): don't guess names.
  if (mode === "people" && !agent.audience) return t("audience.notice.some", g);
  const names = audienceNames(agent, nameOf);
  if (names.length === 0) return t("audience.notice.nobody", g);
  return t("audience.notice.only", { ...g, names: joinNames(names, t("newAgent.and")) });
}

/** The profile summary: "Todos do workspace", "Walter e mais 2 pessoas", "Só Walter". */
export function audienceSummary(t: TFunction, agent: Agent, nameOf: (userId: string) => string | undefined): string {
  const a = audienceOf(agent);
  const owner = agent.ownerUserId ? nameOf(agent.ownerUserId) : undefined;
  if (a.mode === "everyone") return t("audience.summary.everyone");
  if (a.mode === "owner") return owner ? t("audience.summary.owner", { name: owner }) : t("audience.summary.nobody");
  const names = audienceNames(agent, nameOf);
  if (names.length === 0) return t("audience.summary.someone");
  if (names.length <= 3) return t("audience.summary.people", { names: joinNames(names, t("newAgent.and")) });
  return t("audience.summary.many", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
}
