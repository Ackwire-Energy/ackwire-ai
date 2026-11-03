import type { TFunction } from "i18next";
import type { Agent, AgentDraft, AgentProposalCard, AiStatus, ProposedRoutine, SuggestedAi } from "../api/types";
import type { Level } from "./access-levels";
import { joinNames } from "./format";
import { aiStateOf, PLAN_BRAIN } from "./no-ai";
import { type UsagePauseCard, usagePauseCardOf } from "./usage-pause";

/**
 * An agent's action card (ADR 0061, `meta.actionCard`): its button opens the app's own dialog, filled in.
 * The card keeps no state; whether it's done comes from live data. Platform-neutral (web and phone).
 */

export type ConnectAiStep = "claude" | "chatgpt" | "api_key";

/** "Conectar uma IA": the Connect dialog at a step, for the agents the card names. */
export interface ConnectAiCard {
  kind: "connect_ai";
  /** Who the agent offered it to (the person behind its run). */
  forUserId: string | null;
  /** None: the dialog's first step (a plan or a key). */
  what?: ConnectAiStep;
  /** With `api_key`: the provider to pick. */
  provider?: string;
  /** None: any agent the person may change. */
  agentIds: string[];
  /** The agent's line for the person. */
  why: string;
}

const STEPS: ReadonlySet<string> = new Set<ConnectAiStep>(["claude", "chatgpt", "api_key"]);

/**
 * A stretch's pause card (ADR 0089): agents did what they may do on their own since a person last acted, and wait
 * here. Continuar (`api.chat.answerNow` on the card) lets them go on; the card then says who did, and when.
 */
export interface StretchCard {
  kind: "stretch_paused";
  state: "paused" | "continued";
  /** `runs`: the steps agents may take on their own ran out (`limit`, never shown); `spend`: `limit`% of an agent's monthly budget. */
  reason: "runs" | "spend";
  limit: number;
  /** The person behind the work (else the routine's creator): with the agents' owners and admins, who may go on. */
  forUserId: string | null;
  /** The agents that stopped. */
  agentIds: string[];
  continuedByUserId: string | null;
  continuedAt: string | null;
}

export function stretchCardOf(meta: Record<string, unknown> | null | undefined): StretchCard | null {
  const raw = meta?.actionCard as Partial<StretchCard> | undefined;
  if (raw?.kind !== "stretch_paused" || !Array.isArray(raw.agentIds) || typeof raw.limit !== "number") return null;
  return {
    kind: "stretch_paused",
    state: raw.state === "continued" ? "continued" : "paused",
    reason: raw.reason === "spend" ? "spend" : "runs",
    limit: raw.limit,
    forUserId: typeof raw.forUserId === "string" ? raw.forUserId : null,
    agentIds: raw.agentIds.filter((id): id is string => typeof id === "string"),
    continuedByUserId: typeof raw.continuedByUserId === "string" ? raw.continuedByUserId : null,
    continuedAt: typeof raw.continuedAt === "string" ? raw.continuedAt : null,
  };
}

/**
 * "Ada e Theo pararam para checar com você antes de continuar", in the reader's language. A budget pause says the
 * share it used, and `cost` that share in money for people who may see it ("US$ 10,00"). No step count: it means
 * nothing to the person (an old card's `limit` on a run pause is never shown).
 */
export function stretchCardText(t: TFunction, card: StretchCard, names: string[], cost?: string | null) {
  // Plurals by `count` and the `_cost` context are past what the typed keys can check here.
  const say = t as unknown as (key: string, options: Record<string, unknown>) => string;
  const agents = joinNames(names, t);
  const count = names.length;
  if (card.reason === "runs") return say("chat.body.stretch_paused_runs", { agents, count });
  return say("chat.body.stretch_paused_spend", {
    agents,
    count,
    percent: card.limit,
    ...(cost ? { context: "cost", amount: cost } : {}),
  });
}

/** Continuar is for whoever asked, the agents' owners or an admin: the same people as Continuar under a stopped reply. */
export const mayContinueStretch = (
  card: StretchCard,
  meId: string | null,
  ownerOf: (agentId: string) => string | null | undefined,
  admin: boolean,
) => admin || (meId !== null && (card.forUserId === meId || card.agentIds.some((id) => ownerOf(id) === meId)));

export type ActionCard = ConnectAiCard | AgentProposalCard | StretchCard | UsagePauseCard;

/** An agent's proposal of a new agent (ADR 0081), or null. Unlike the Connect card, it keeps its state. */
export function agentProposalOf(meta: Record<string, unknown> | null | undefined): AgentProposalCard | null {
  const raw = meta?.actionCard as Partial<AgentProposalCard> | undefined;
  return raw?.kind === "agent_proposal" && raw.params?.draft && typeof raw.expiresAt === "string"
    ? (raw as AgentProposalCard)
    : null;
}

/** Where a proposal stands: waiting for a person (also while someone creates it), expired, created or denied. */
export function proposalStatus(card: AgentProposalCard, now = Date.now()): "open" | "expired" | "created" | "denied" {
  if (card.state === "created" || card.state === "denied") return card.state;
  return Date.parse(card.expiresAt) <= now ? "expired" : "open";
}

/** "Pensa com Claude Max", "Pensa pela API", "Sem IA ainda…": the AI a proposal suggests. */
export const suggestedAiText = (t: TFunction, ai: SuggestedAi) =>
  ai.kind === "account"
    ? t("actionCard.agentProposal.aiAccount", { account: ai.label })
    : t(ai.kind === "model" ? "actionCard.agentProposal.aiModel" : "actionCard.agentProposal.aiNone");

/** A created proposal's routine nobody made yet (its agent wasn't where it reports): it can still be made. */
export const routineLeft = (card: AgentProposalCard) =>
  card.state === "created" && !!card.agentId && !!card.params.draft.routine && !card.routineId;

/** The draft's connector levels as "Criar agente" keeps them (by connection; the rest none). */
export const draftLevels = (draft: AgentDraft): Record<string, Level> =>
  Object.fromEntries(draft.access.map((a) => [a.connectionId, a.level]));

/**
 * The draft's mailbox levels the reviewer gives (their own mailboxes: only a mailbox's owner gives an agent access to
 * it), as "Criar agente" keeps them.
 */
export const draftMailLevels = (draft: AgentDraft, meId: string): Record<string, Level> =>
  Object.fromEntries((draft.mail ?? []).filter((m) => m.ownerUserId === meId).map((m) => [m.accountId, m.level]));

/** Who gives a line of a proposal: an admin (a channel, an app), or only one person (their mailbox). */
export type LineGiver = { who: "admin" } | { who: "person"; userId: string };

/**
 * A line of what a proposed agent gets, as its card lists it: a channel, an app or a mailbox at a level, its routine.
 * `given`: created in one click, whether it got it (null while open, or when it was created from the review). `needs`:
 * who gives it when the viewer can't (open), or when nobody did yet (created in one click).
 */
export interface ProposalLine {
  key: string;
  kind: "channel" | "app" | "mail" | "routine";
  /** The channel's, connection's or mailbox's id (the routine: its name). */
  id: string;
  level?: "read" | "write";
  given: boolean | null;
  needs: LineGiver | null;
}

/** The lines of a proposal's card for this viewer (who may manage agents: `admin`). */
export function proposalLines(card: AgentProposalCard, viewer: { userId: string; admin: boolean }): ProposalLine[] {
  const { draft } = card.params;
  const status = proposalStatus(card);
  const applied = status === "created" ? card.applied : undefined;
  const admin: LineGiver = { who: "admin" };
  const line = (
    kind: ProposalLine["kind"],
    id: string,
    given: string[] | undefined,
    giver: LineGiver,
    viewerGives: boolean,
    level?: "read" | "write",
  ): ProposalLine => {
    const got = applied && given ? given.includes(id) : null;
    const needs = status === "open" ? (viewerGives ? null : giver) : got === false ? giver : null;
    return { key: `${kind}:${id}`, kind, id, ...(level ? { level } : {}), given: got, needs };
  };
  return [
    ...draft.channelIds.map((id) => line("channel", id, applied?.channelIds, admin, viewer.admin)),
    ...draft.access.map((a) => line("app", a.connectionId, applied?.connectionIds, admin, viewer.admin, a.level)),
    ...(draft.mail ?? []).map((m) =>
      line(
        "mail",
        m.accountId,
        applied?.mailAccountIds,
        { who: "person", userId: m.ownerUserId },
        // Only its owner gives it, admin or not; an admin who isn't sees who must.
        m.ownerUserId === viewer.userId,
        m.level,
      ),
    ),
    ...(draft.routine ? [routineLine(card, draft.routine, status, viewer.admin)] : []),
  ];
}

/** Its routine waits for whoever puts the agent in the channel it reports in (an admin), when nobody did yet. */
function routineLine(
  card: AgentProposalCard,
  routine: ProposedRoutine,
  status: ReturnType<typeof proposalStatus>,
  admin: boolean,
): ProposalLine {
  const applied = status === "created" ? card.applied : undefined;
  const given = status === "created" && (applied || card.routineId) ? Boolean(card.routineId) : null;
  const where = routine.reportsIn;
  const waits = !!where && !(applied ? applied.channelIds.includes(where) : admin);
  const needs = (status === "open" || given === false) && waits ? ({ who: "admin" } as const) : null;
  return { key: "routine", kind: "routine", id: routine.name, given, needs };
}

export function actionCardOf(meta: Record<string, unknown> | null | undefined): ActionCard | null {
  const proposal = agentProposalOf(meta) ?? stretchCardOf(meta) ?? usagePauseCardOf(meta);
  if (proposal) return proposal;
  const raw = meta?.actionCard;
  if (!raw || typeof raw !== "object") return null;
  const card = raw as { kind?: unknown; forUserId?: unknown; params?: unknown };
  if (card.kind !== "connect_ai" || !card.params || typeof card.params !== "object") return null;
  const p = card.params as Record<string, unknown>;
  return {
    kind: "connect_ai",
    forUserId: typeof card.forUserId === "string" ? card.forUserId : null,
    ...(typeof p.what === "string" && STEPS.has(p.what) ? { what: p.what as ConnectAiStep } : {}),
    ...(typeof p.provider === "string" ? { provider: p.provider } : {}),
    agentIds: Array.isArray(p.agentIds) ? p.agentIds.filter((id): id is string => typeof id === "string") : [],
    why: typeof p.why === "string" ? p.why : "",
  };
}

/**
 * Done once every agent the card names can think, and for a plan's card thinks with that plan. A card that
 * names no agent (an organization's key) stays a button: nothing live says which key it was for.
 */
export function connectAiDone(
  card: ConnectAiCard,
  status: AiStatus | undefined,
  agentById: ReadonlyMap<string, Pick<Agent, "brain">>,
) {
  if (!status || card.agentIds.length === 0) return false;
  const brain = card.what === "claude" || card.what === "chatgpt" ? PLAN_BRAIN[card.what] : null;
  return card.agentIds.every(
    (id) => aiStateOf(status, id) === "ready" && (!brain || agentById.get(id)?.brain?.kind === brain),
  );
}
