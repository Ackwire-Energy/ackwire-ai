import type { TFunction } from "i18next";
import type { ApiClient } from "../api/client";
import type { Agent, AgentBrain, BrainScope, Credential, DirectMessage, Model } from "../api/types";
import { agentGrammar } from "./grammar";
import { PRESETS } from "./onboarding";
import { AUTO, keyRuns } from "./providers";

/** The workspace's right hand (ADR 0137): every surface that treats it apart asks here. */
export const isRightHand = (agent: Pick<Agent, "builtin"> | null | undefined) => agent?.builtin === "right_hand";

/** Whether a channel's member pickers offer the agent: never the right hand, in no channel (an @mention reaches it). */
export const joinsChannels = (agent: Pick<Agent, "builtin">) => !isRightHand(agent);

/**
 * Whether an @mention in a conversation of `kind` reaches the agent though it isn't a member there: the right hand, in
 * any channel, never a DM (the server's `rightHandReaches`). The "@" pickers count it as in, with nothing to add.
 */
export const mentionReaches = (agent: Pick<Agent, "builtin">, kind: "channel" | "dm") =>
  kind === "channel" && isRightHand(agent);

/**
 * What the person's DM thinks with while they have no AI of their own (ADR 0137 §11), as one line: the workspace's key,
 * its plan where that serves them, or that it doesn't. `name`: its grammar (`agentGrammar`); `firstName`: of a member.
 */
export function rightHandFallback(
  t: TFunction,
  ai: NonNullable<AgentBrain["workspaceAi"]>,
  meId: string | undefined,
  name: Record<string, unknown>,
  firstName: (userId: string) => string | undefined,
  /** This server has a key of its own, which serves where the workspace has none. */
  platform = false,
): string {
  if (ai.brain === "model") {
    if (ai.key) return t("rightHand.settings.fallbackKeyOf", { label: ai.key.label });
    return t(ai.key === null && !platform ? "rightHand.settings.fallbackNoKey" : "rightHand.settings.fallbackKey");
  }
  const owner = (ai.ownerId && firstName(ai.ownerId)) ?? "";
  if (!ai.servesYou) return t("rightHand.settings.fallbackNone", { ...name, owner });
  return ai.ownerId === meId ? t("rightHand.settings.fallbackYours") : t("rightHand.settings.fallbackPlan", { owner });
}

/**
 * "Sua IA" as one status, web and phone alike: what answers the person in their own DM with the right hand. `own`: a
 * plan of theirs or one shared with them (`ownerId` when it isn't theirs); `key`: the workspace's API key, or this
 * server's own where the workspace has none (`label` absent); `plan`: the workspace's plan, which serves them;
 * `nobody`: nothing does yet. Null while the view loads.
 */
export type MineStatus =
  | { kind: "own"; brain: AgentBrain["brain"]; label?: string; ownerId?: string }
  | { kind: "key"; label?: string; provider?: string }
  | { kind: "plan"; brain: AgentBrain["brain"] }
  | { kind: "nobody" };

export function mineStatus(view: AgentBrain | undefined, meId: string, platform: boolean): MineStatus | null {
  if (!view) return null;
  if (view.brain !== "model") {
    const signIn = view.accounts.find((a) => a.id === view.account);
    const ownerId = signIn?.ownerId && signIn.ownerId !== meId ? signIn.ownerId : undefined;
    return { kind: "own", brain: view.brain, label: signIn?.label, ownerId };
  }
  const ai = view.workspaceAi;
  if (!ai) return { kind: "nobody" };
  if (ai.brain === "model") {
    if (ai.key) return { kind: "key", label: ai.key.label, provider: ai.key.provider };
    return ai.key === null && !platform ? { kind: "nobody" } : { kind: "key" };
  }
  return ai.servesYou ? { kind: "plan", brain: ai.brain } : { kind: "nobody" };
}

/**
 * What a connect flow says once an AI is chosen. The team's right hand has two AIs, and the words say which moved:
 * the workspace's (everyone without a plan of their own) or the person's alone. Any other agent has one.
 */
export const thinksWithLine = (t: TFunction, scope: BrainScope | undefined, agent: string, label: string) =>
  scope
    ? t(`rightHand.saved.${scope}`, { ...agentGrammar(agent), label })
    : t("aiAccounts.done.savedAgent", { agent, label });

/**
 * The right hand on a workspace key, web and phone: the workspace's AI goes to its API key, the key is pinned, with
 * Automático where the model chosen before can't run on it, and the person's own DM goes back to that AI. In that
 * order: someone the workspace's AI refuses keeps their own as it was.
 */
export async function rightHandOnKey(
  api: ApiClient,
  orgId: string,
  agent: Pick<Agent, "id" | "model">,
  key: Pick<Credential, "id" | "provider">,
  models: readonly Model[],
) {
  await api.agents.setBrain(orgId, agent.id, { scope: "workspace", brain: "model" });
  const fits = keyRuns(key, agent.model, models);
  await api.agents.update(orgId, agent.id, { credentialId: key.id, ...(fits ? {} : { model: AUTO }) });
  await api.agents.setBrain(orgId, agent.id, { brain: "model" });
}

/** Its one-time "Novo" is per person and workspace (`seenList` entries), gone once its DM opened. */
export const rightHandSeenKey = (userId: string, orgId: string) => `${userId}.${orgId}`;

/**
 * Whether this is the person's first visit to the right hand's DM, so it waves under its greeting (ADR 0137 §6):
 * they never read it, on any device. Unknown (undefined) while their DMs load or before it is one of them.
 */
export function firstVisitOf(dms: readonly DirectMessage[] | undefined, agentId: string): boolean | undefined {
  const dm = dms?.find((d) => d.with.type === "agent" && d.with.id === agentId);
  return dm ? dm.everRead === false : undefined;
}

/** The workspace's right hand among its agents, when this person may see it. */
export const rightHandOf = <A extends Pick<Agent, "builtin">>(agents: readonly A[]) => agents.find(isRightHand);

/**
 * Its name and look before the workspace exists (the onboarding's first question): the server's
 * `RIGHT_HAND_DEFAULTS` (packages/engine/src/right-hand.ts).
 */
export const RIGHT_HAND_DEFAULT = {
  name: "Lodi",
  appearance: { color: "teal", eyes: "happy", accessory: "headset" },
} as const;

/** Where its name comes from ("lodestar") is told only while it keeps that name: a renamed one has another story. */
export const tellsNameStory = (agent: Pick<Agent, "builtin" | "name"> | null | undefined) =>
  isRightHand(agent) && agent?.name === RIGHT_HAND_DEFAULT.name;

/**
 * Ends a workspace's onboarding, for good, and says where it opens: its right hand's DM (ADR 0137), which takes the
 * setup on from there; the workspace itself (`agentId` null) when there is none to open.
 */
export async function finishOnboarding(api: ApiClient, orgId: string) {
  await api.orgs.saveOnboarding(orgId, { finished: true });
  const rightHand = rightHandOf(await api.agents.list(orgId).catch(() => []));
  return { orgId, agentId: rightHand?.id ?? null };
}

/** The ready-made agents not created yet, by handle. */
export const presetsLeft = (teamHandles: readonly string[]) => PRESETS.filter((p) => !teamHandles.includes(p));

/**
 * Whether its greeting ends with the way to build the team again, for whoever may create agents once an AI is there:
 * only with a team and no card left under the greeting (`cards`), which would offer the same or ask something first.
 */
export const offersTeamSetup = (s: {
  noAi: boolean;
  aiKnown: boolean;
  createsAgents: boolean;
  hasTeam: boolean;
  /** `introCards`. */
  cards: readonly string[];
  /** A billing hold (`planHoldOf`): it can't answer, so its line would send a message that gets refused. */
  held?: boolean;
}) => s.aiKnown && !s.noAi && !s.held && s.createsAgents && s.hasTeam && s.cards.length === 0;

/**
 * The cards under the right hand's greeting at the top of its DM (ADR 0137), one question at a time: Connect AI while
 * there is none. With one, how to start (for whoever may create agents): with no agent yet, or, still alone, while the
 * team is only ready-made agents and some are left, each tile its own Criar, beside what next. Once that is settled,
 * how the person wants agents to talk to them, until they pick (ADR 0147), and only then what next: the team here and
 * nobody else yet. On a billing hold, how to start and what next alone: an AI comes after the plan, and a saved key
 * reading as ready changes nothing.
 */
export function introCards(s: {
  noAi: boolean;
  /** The AI status has loaded. */
  aiKnown: boolean;
  /** The handles of the agents besides the right hand. */
  teamHandles: readonly string[];
  createsAgents: boolean;
  /** The person is the workspace's only member. */
  alone: boolean;
  /** They never picked how agents talk to them (`agentStyle` null; undefined from an older server). */
  askStyle?: boolean;
  /** A billing hold (`planHoldOf`). */
  held?: boolean;
  /** A no-AI card already answered them in this conversation: its Connect is the one to press. */
  noAiCard?: boolean;
}): ("connect" | "start" | "next" | "style")[] {
  if (s.noAi && !s.held) return s.noAiCard ? [] : ["connect"];
  const presets = new Set<string>(PRESETS);
  const start =
    s.aiKnown &&
    s.createsAgents &&
    (s.teamHandles.length === 0 ||
      (s.alone && presetsLeft(s.teamHandles).length > 0 && s.teamHandles.every((h) => presets.has(h))));
  const next = s.teamHandles.length > 0 && s.alone;
  if (start) return next ? ["start", "next"] : ["start"];
  if (s.askStyle && s.aiKnown && !s.held) return ["style"];
  return next ? ["next"] : [];
}
