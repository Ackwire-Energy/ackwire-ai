import { planOf } from "@agenteschat/providers/plans";
import type { TFunction } from "i18next";
import type {
  Agent,
  AgentAudience,
  AgentSetupResult,
  AudienceMode,
  ForeignMailbox,
  OrgRole,
  OrgSummary,
} from "../api/types";
import { engineOfBrain } from "./brain";
import { joinNames } from "./format";
import { agentGrammar } from "./grammar";
import { can } from "./permissions";
import { isEveryone, sortRoles } from "./roles";

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

/** Whether a button may send me to its DM: I talk to agents at all, and this one answers me. */
export const mayAsk = (org: OrgSummary | null | undefined, agent: Pick<Agent, "canTalk"> | undefined) =>
  can(org, "talk_to_agents") && canTalk(agent);

/**
 * Whether I see how it works (instructions, tools and access, memory, files, usage, activity, settings): the
 * server's `seesDetails`, the same rule its routes enforce. Without it, only its public card.
 */
export const seesDetails = (agent: { seesDetails?: boolean } | undefined) => agent?.seesDetails !== false;

/** Whether its picture leads to its details: not an agent no longer in the team, nor for who sees only its public card. */
export const opensDetails = (agent: { seesDetails?: boolean; former?: unknown } | undefined) =>
  Boolean(agent) && !agent?.former && seesDetails(agent);

/**
 * Whether my lists and pickers show the agent: every agent for who manages agents, who arrange the team (the lock
 * says who it answers), only the ones that answer me for everyone else. From the server's `canTalk` (the agent's
 * audience and `talk_to_agents`), so a later limit per person reaches every list unchanged.
 */
export const listsAgent = (org: OrgSummary | null | undefined, agent: Pick<Agent, "canTalk"> | undefined) =>
  can(org, "manage_agents") || canTalk(agent);

/**
 * The agents my lists leave out (`listsAgent`, from the server's `canTalk`): unless I manage agents, the ones not
 * answering me.
 */
export const hiddenAgentIds = (org: OrgSummary | null | undefined, agents: readonly Pick<Agent, "id" | "canTalk">[]) =>
  new Set(agents.filter((a) => !listsAgent(org, a)).map((a) => a.id));

/** A DM with one of `hiddenAgents` (`hiddenAgentIds`): off the lists and their counts. */
export const hiddenDm = (d: { with: { type: string; id: string } }, hiddenAgents: ReadonlySet<string> | undefined) =>
  d.with.type === "agent" && hiddenAgents?.has(d.with.id) === true;

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

/**
 * Whether "Outros agentes podem consultar" applies: someone is left out, and it doesn't think with a plan answering only
 * its owner (ADR 0059 §5), where nobody else is answered, consulted or not (same rule as the backend).
 */
export const offersConsultable = (a: AgentAudience, onPlan: boolean) =>
  a.mode !== "everyone" && !(onPlan && a.mode === "owner");

/**
 * Whether a narrowed audience holds for other agents too, as the line under it says (`audience.agents.*`): they still
 * consult it for the rest, they don't, or its owner's plan keeps everyone else out. Null: everyone can talk to it.
 */
export const agentsReach = (
  a: AgentAudience,
  onPlan: boolean,
  ownerUserId: string | null,
): "consulted" | "blocked" | "plan" | null =>
  a.mode === "everyone"
    ? null
    : onPlan && !answersOthers({ ...a, consultable: false }, ownerUserId)
      ? "plan"
      : a.consultable === false
        ? "blocked"
        : "consulted";

/** On a plan only its owner turns the switch back on (ADR 0059 §5); anyone else may only turn it off. */
export const consultableLocked = (saved: AgentAudience, viewer: { owner: boolean; onPlan: boolean }) =>
  viewer.onPlan && !viewer.owner && saved.consultable === false;

/** Someone besides its owner can talk to the agent. */
export const answersOthers = (a: AgentAudience, ownerUserId: string | null) =>
  audienceWidens({ mode: "owner", userIds: [] }, a, ownerUserId);

/** Only the agent's owner and who manages agents change who talks to it (same rule as the backend). */
export const canEditAudience = (org: OrgSummary | undefined, agent: Agent, myUserId: string) =>
  can(org, "manage_agents") || (agent.ownerUserId != null && agent.ownerUserId === myUserId);

/** What a save sends: the people and roles only when it answers some people. */
export const audiencePatch = (a: AgentAudience): AgentAudience => ({
  mode: a.mode,
  userIds: a.mode === "people" ? a.userIds : [],
  roleIds: a.mode === "people" ? (a.roleIds ?? []) : [],
  consultable: a.consultable ?? true,
});

/** Everyone in the workspace: what "Atende outras pessoas" turned on lets in at most. */
export const EVERYONE_AUDIENCE: AgentAudience = { mode: "everyone", userIds: [], roleIds: [] };

/**
 * Saving `next` lets more people talk to an agent that thinks with someone else's plan (ADR 0059 §5): their plan pays
 * for those conversations, so the apps ask first, and the server emails its owner.
 */
export const opensOthersPlan = (agent: Agent, next: AgentAudience, myUserId: string) =>
  engineOfBrain(agent.brain?.kind) !== "agent" &&
  // A plan of theirs thinks for it (`account`): not OpenCode's free tier on a computer nobody connected (ADR 0132).
  agent.brain?.account !== undefined &&
  agent.ownerUserId != null &&
  agent.ownerUserId !== myUserId &&
  audienceWidens(audienceOf(agent), next, agent.ownerUserId);

/**
 * "Let me talk to it": its audience with me let in, when it keeps me out and I may change it (its owner or who manages
 * agents) and I talk to agents at all; null otherwise. On someone else's plan the save asks first (`opensOthersPlan`).
 */
export function audienceWithMe(org: OrgSummary | undefined, agent: Agent, myUserId: string): AgentAudience | null {
  if (canTalk(agent) || !can(org, "talk_to_agents") || !canEditAudience(org, agent, myUserId)) return null;
  return audienceWith(agent, myUserId);
}

/** Why to ask before widening its audience: the agent loses the mailboxes others gave it, named by whose they are. */
export const mailLossText = (t: TFunction, agent: Pick<Agent, "name">, mailboxes: readonly ForeignMailbox[]) =>
  t("reach.mailLoss", {
    ...agentGrammar(agent.name),
    owners: joinNames([...new Set(mailboxes.map((m) => m.ownerName ?? m.address))], t),
  });

/**
 * The one question before widening its audience, or null when there is nothing to ask: on someone else's plan
 * (`planOwner`: their name, from `opensOthersPlan`), whose plan and limits it uses and that they get an email, and the
 * mailboxes it loses (`mailLossText`).
 */
export function widenQuestion(
  t: TFunction,
  agent: Pick<Agent, "name" | "brain">,
  planOwner: string | null,
  mailboxes: readonly ForeignMailbox[],
): { title: string; description: string } | null {
  const mail = mailboxes.length > 0 ? mailLossText(t, agent, mailboxes) : null;
  if (!planOwner) return mail ? { title: t("reach.mailLossTitle"), description: mail } : null;
  const why = t("reach.planOpen", { name: agent.name, owner: planOwner, plan: planName(t, agent.brain) });
  return {
    title: t("reach.planTitle", { owner: planOwner }),
    description: mail ? t("common.joinSentences", { a: why, b: mail }) : why,
  };
}

/** The plan a brain thinks with, as the email to its owner says it (the engine's `planName`): a coding plan's own. */
function planName(t: TFunction, brain: Pick<NonNullable<Agent["brain"]>, "kind" | "provider"> | null | undefined) {
  const kind = brain?.kind && brain.kind !== "model" ? brain.kind : "claude_code";
  const provider = brain?.provider ?? undefined;
  const coding = planOf(provider);
  return coding ? (provider === "opencode" ? coding.name : coding.maker) : t(`aiAccounts.connect.${kind}`);
}

/**
 * The one question before "Usar em outros agentes" lets more people talk to agents on other people's plans (the
 * preview's `opensPlan`): whose plans, one line per owner naming their agents; null when it opens none.
 */
export function setupPlanQuestion(
  t: TFunction,
  brain: Pick<NonNullable<Agent["brain"]>, "kind" | "provider">,
  opened: readonly { agent: string; owner: string }[],
): { title: string; description: string } | null {
  const byOwner = new Map<string, string[]>();
  for (const o of opened) byOwner.set(o.owner, [...(byOwner.get(o.owner) ?? []), o.agent]);
  const owners = [...byOwner.keys()];
  const [only] = owners;
  if (only === undefined) return null;
  const plan = planName(t, brain);
  return {
    title:
      owners.length === 1
        ? t("reach.planTitle", { owner: only })
        : t("reach.plansTitle", { owners: joinNames(owners, t) }),
    description: [...byOwner]
      .map(([owner, agents]) => t("reach.planOpen", { name: joinNames(agents, t), owner, plan }))
      .join("\n"),
  };
}

/** The setup's results that open someone else's plan, among `agentIds`, with each agent's and owner's name. */
export function setupPlanOpens(
  results: readonly AgentSetupResult[],
  agentIds: readonly string[],
  agentOf: (id: string) => Pick<Agent, "name" | "ownerUserId"> | undefined,
  ownerName: (userId: string) => string,
): { agent: string; owner: string }[] {
  return results.flatMap((r) => {
    const a = r.opensPlan && agentIds.includes(r.agentId) ? agentOf(r.agentId) : undefined;
    return a?.ownerUserId ? [{ agent: a.name, owner: ownerName(a.ownerUserId) }] : [];
  });
}

/** One line of "Quem pode falar": the whole workspace (its `everyone` role's mark), a role, or a person. */
export type AudienceLine<P> =
  | { kind: "everyone"; role?: OrgRole }
  | { kind: "role"; role: OrgRole }
  | { kind: "person"; person: P };

/**
 * Who it answers, one line each: everyone; only its owner; or its roles (top first), then its people. Its owner
 * isn't among the people (it always may); only the roles and people we know.
 */
export function audienceLines<P extends { userId: string }>(
  agent: Agent,
  roles: readonly OrgRole[],
  members: readonly P[],
): AudienceLine<P>[] {
  const a = audienceOf(agent);
  const person = (id: string) => members.find((m) => m.userId === id);
  if (a.mode === "everyone") return [{ kind: "everyone", role: roles.find(isEveryone) }];
  const ids = a.mode === "owner" ? (agent.ownerUserId ? [agent.ownerUserId] : []) : a.userIds;
  const people = ids
    .filter((id) => a.mode === "owner" || id !== agent.ownerUserId)
    .flatMap((id) => {
      const p = person(id);
      return p ? [{ kind: "person" as const, person: p }] : [];
    });
  const picked = a.mode === "people" ? sortRoles(roles.filter((r) => a.roleIds.includes(r.id))) : [];
  return [...picked.map((role) => ({ kind: "role" as const, role })), ...people];
}

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
  const g = agentGrammar(agent.name);
  // From the directory list (mode only, no user ids): don't guess names.
  if (mode === "people" && !agent.audience) return t("audience.notice.some", g);
  const names = audienceNames(agent, nameOf, roleName);
  if (names.length === 0) return t("audience.notice.nobody", g);
  return t("audience.notice.only", { ...g, names: joinNames(names, t) });
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
  if (names.length <= 3) return t("audience.summary.people", { names: joinNames(names, t) });
  const shown = names.slice(0, 2).join(", ");
  const count = names.length - 2;
  // Only people left over: "e mais 2 pessoas".
  if (roles.length <= 2) return t("audience.summary.manyPeople", { names: shown, count });
  return t("audience.summary.many", { names: shown, count });
}
