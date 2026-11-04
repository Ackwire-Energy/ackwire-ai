import type { TFunction } from "i18next";
import type {
  Agent,
  AgentDraft,
  AgentProposalCard,
  AiStatus,
  CardDelegate,
  CostKind,
  CostlyDecision,
  ProposedRoutine,
  Skill,
  SuggestedAi,
} from "../api/types";
import type { Level } from "./access-levels";
import type { ConnectedItem } from "./connected";
import { isHttpsUrl, sameServer } from "./custom-tools";
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

/**
 * "Conectar Linear" / "Adicionar MCP" (`offer_connect_app`): the connect dialog at a catalog entry, or at connecting by
 * address with `url` filled in (neither: the address is typed there).
 */
export interface ConnectAppCard {
  kind: "connect_app";
  forUserId: string | null;
  connector?: string;
  url?: string;
  why: string;
}

/** "Convidar pessoas" (`offer_invites`): the invite dialog with these addresses filled in, as members. */
export interface InviteCard {
  kind: "invite_people";
  forUserId: string | null;
  emails: string[];
  why: string;
}

/**
 * "Instalar skill" (`offer_install_skill`): the install dialog with the skill's GitHub link filled in, where a person
 * who manages skills picks it and installs it.
 */
export interface InstallSkillCard {
  kind: "install_skill";
  forUserId: string | null;
  url: string;
  why: string;
}

/**
 * "Atualizar skills" (`update_skill_from_source`): the skills to update from their links, or whose update waits on
 * its files that run; each opens in Skills, where who manages skills updates it or applies what waits.
 */
export interface UpdateSkillsCard {
  kind: "update_skills";
  forUserId: string | null;
  skillIds: string[];
  why: string;
}

/**
 * The right hand's card of a teammate's settings (ADR 0137): one card, a row per agent and decider
 * (`proposals.list({ ids })` reads them).
 */
export interface SettingsProposalCard {
  kind: "settings_proposal";
  forUserId: string | null;
  proposalIds: string[];
  /** The right hand looked at it for the person it is for (ADR 0138 §2). */
  delegate?: CardDelegate | null;
}

export type ActionCard =
  | ConnectAiCard
  | ConnectAppCard
  | InviteCard
  | InstallSkillCard
  | UpdateSkillsCard
  | SettingsProposalCard
  | AgentProposalCard
  | StretchCard
  | UsagePauseCard
  | CostlyProposalCard;

/**
 * An agent asks before costly work nobody asked for directly (ADR 0131 §3): opening a PR, installing packages, a long
 * job. Its person (or the agent's owner, or who manages agents) says go for this time, always, not now, or never for
 * this kind; the card keeps what they said.
 */
export interface CostlyProposalCard {
  kind: "autonomy_proposal";
  signalId: string;
  agentId: string;
  cost: CostKind;
  /** What it wants to run or call, as the agent would (a command, a tool). */
  what: string;
  forUserId: string | null;
  state: "open" | CostlyDecision;
  decidedByUserId: string | null;
}

/** The costly-work proposal on a message, or null. */
export function costlyProposalOf(meta: Record<string, unknown> | null | undefined): CostlyProposalCard | null {
  const raw = meta?.actionCard as Partial<CostlyProposalCard> | undefined;
  if (raw?.kind !== "autonomy_proposal" || typeof raw.signalId !== "string" || typeof raw.agentId !== "string")
    return null;
  const cost: CostKind = raw.cost === "install" || raw.cost === "long" ? raw.cost : "pr";
  const states = ["go", "not_now", "never", "always"] as const;
  return {
    kind: "autonomy_proposal",
    signalId: raw.signalId,
    agentId: raw.agentId,
    cost,
    what: typeof raw.what === "string" ? raw.what : "",
    forUserId: typeof raw.forUserId === "string" ? raw.forUserId : null,
    state: states.find((s) => s === raw.state) ?? "open",
    decidedByUserId: typeof raw.decidedByUserId === "string" ? raw.decidedByUserId : null,
  };
}

/** Who may decide it: the person it is for, the agent's owner, or someone who manages agents. */
export const mayDecideCostly = (
  card: CostlyProposalCard,
  userId: string,
  ownerOf: (agentId: string) => string | null | undefined,
  managesAgents: boolean,
) => card.forUserId === userId || mayRememberCostly(card, userId, ownerOf, managesAgents);

/** Who may answer it for every time ("Sempre", "Nunca"), which changes the agent: its owner or who manages agents. */
export const mayRememberCostly = (
  card: CostlyProposalCard,
  userId: string,
  ownerOf: (agentId: string) => string | null | undefined,
  managesAgents: boolean,
) => ownerOf(card.agentId) === userId || managesAgents;

/** An agent's proposal of a new agent (ADR 0081), or null. Unlike the Connect card, it keeps its state. */
export function agentProposalOf(meta: Record<string, unknown> | null | undefined): AgentProposalCard | null {
  const raw = meta?.actionCard as Partial<AgentProposalCard> | undefined;
  return raw?.kind === "agent_proposal" && raw.params?.draft && typeof raw.expiresAt === "string"
    ? (raw as AgentProposalCard)
    : null;
}

/**
 * Where a proposal stands: waiting for a person (also while someone creates it), expired, created, denied, or
 * superseded by a newer card for the same agent.
 */
export function proposalStatus(
  card: AgentProposalCard,
  now = Date.now(),
): "open" | "expired" | "created" | "denied" | "superseded" {
  if (card.state === "created" || card.state === "denied" || card.state === "superseded") return card.state;
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
  const proposal = agentProposalOf(meta) ?? stretchCardOf(meta) ?? usagePauseCardOf(meta) ?? costlyProposalOf(meta);
  if (proposal) return proposal;
  const raw = meta?.actionCard;
  if (!raw || typeof raw !== "object") return null;
  if ((raw as { kind?: unknown }).kind === "settings_proposal") {
    const r = raw as { forUserId?: unknown; proposalIds?: unknown; delegate?: CardDelegate | null };
    const proposalIds = Array.isArray(r.proposalIds)
      ? r.proposalIds.filter((id): id is string => typeof id === "string")
      : [];
    return proposalIds.length > 0
      ? {
          kind: "settings_proposal",
          forUserId: typeof r.forUserId === "string" ? r.forUserId : null,
          proposalIds,
          delegate: r.delegate ?? null,
        }
      : null;
  }
  const card = raw as { kind?: unknown; forUserId?: unknown; params?: unknown };
  if (!card.params || typeof card.params !== "object") return null;
  const p = card.params as Record<string, unknown>;
  const forUserId = typeof card.forUserId === "string" ? card.forUserId : null;
  const why = typeof p.why === "string" ? p.why : "";
  if (card.kind === "connect_app") {
    return {
      kind: "connect_app",
      forUserId,
      ...(typeof p.connector === "string" ? { connector: p.connector } : {}),
      ...(typeof p.url === "string" && isHttpsUrl(p.url) ? { url: p.url } : {}),
      why,
    };
  }
  if (card.kind === "install_skill") {
    return typeof p.url === "string" && isHttpsUrl(p.url)
      ? { kind: "install_skill", forUserId, url: p.url, why }
      : null;
  }
  if (card.kind === "update_skills") {
    const skillIds = Array.isArray(p.skillIds) ? p.skillIds.filter((id): id is string => typeof id === "string") : [];
    return skillIds.length > 0 ? { kind: "update_skills", forUserId, skillIds, why } : null;
  }
  if (card.kind === "invite_people") {
    const emails = Array.isArray(p.emails) ? p.emails.filter((e): e is string => typeof e === "string") : [];
    return emails.length > 0 ? { kind: "invite_people", forUserId, emails, why } : null;
  }
  if (card.kind !== "connect_ai") return null;
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

/** Done once the workspace has it: a connection of its catalog entry, or a server at its address. */
export const connectAppDone = (card: ConnectAppCard, items: readonly Pick<ConnectedItem, "def" | "server">[]) =>
  card.connector
    ? items.some((i) => i.def?.id === card.connector)
    : Boolean(card.url) && items.some((i) => sameServer(i.server?.serverUrl, card.url));

/** Done once every address is invited (an invitation open or accepted), by the invitations the viewer may list. */
export const inviteDone = (card: InviteCard, invited: readonly string[]) => {
  const have = new Set(invited.map((e) => e.toLowerCase()));
  return card.emails.every((e) => have.has(e.toLowerCase()));
};

/** Done once the library has a skill installed from the card's link. */
export const installSkillDone = (card: InstallSkillCard, skills: readonly Pick<Skill, "sourceUrl">[]) =>
  skills.some((s) => s.sourceUrl === card.url);

/**
 * Where a skill of an update card stands: `waiting` (its update changes files that run), `done` (its link was read
 * after the card was posted and nothing waits) or `open` (to update from its link). A skill that's gone counts as done.
 */
export function skillUpdateState(skill: Pick<Skill, "checkedAt" | "pendingUpdate"> | undefined, postedAt: string) {
  if (!skill) return "done" as const;
  if (skill.pendingUpdate && !skill.pendingUpdate.dismissed) return "waiting" as const;
  return skill.checkedAt && skill.checkedAt >= postedAt ? ("done" as const) : ("open" as const);
}
