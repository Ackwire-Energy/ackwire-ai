import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, isNotNull, isNull, notInArray, schema, sql } from "@agenteschat/db";
import { AUTO_MODEL } from "@agenteschat/providers";
import { type Agent, HANDLE_PATTERN } from "./agents";
import { type AiStatusDeps, agentAiState } from "./ai-status";
import { type AgentAppearance, validateAppearance } from "./appearance";
import { requireChannelAccess } from "./channels";
import { publishDelivery } from "./delivery";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { getMessage, type Message } from "./messages";
import type { Notice } from "./notices";
import { can, getMembership, requirePermission } from "./organizations";
import { deliverNoticeToRun } from "./run-resume";

const {
  agentRuns,
  agents,
  channels,
  connectorConnections,
  machineAccounts,
  machines,
  messages,
  organizationMembers,
  users,
} = schema;

/** A proposal card's `bodyCode` (the apps say it with `chat.body.agent_proposal`). */
export const AGENT_PROPOSAL_CARD = "agent_proposal";

/**
 * The AI a proposed agent starts with (ADR 0080): an account of the person it is for that thinks for no agent,
 * else the workspace's model when it has a key, else none (connected after it is created).
 */
export type SuggestedAi =
  | { kind: "account"; brain: "claude_code" | "codex"; machineId: string; accountId: string; label: string }
  | { kind: "model" }
  | { kind: "none" };

/** What the agent proposes, as the create-agent screen takes it. */
export interface AgentDraft {
  name: string;
  handle: string;
  role: string;
  instructions: string;
  /** Its look (the app's allow-list); null: the app's default. */
  appearance: AgentAppearance | null;
  /** Public channels it joins. */
  channelIds: string[];
  /** Its access to the workspace's connections (connected apps). */
  access: { connectionId: string; level: "read" | "write" }[];
  ai: SuggestedAi;
}

export type AgentProposalState = "pending" | "creating" | "created" | "denied";

/**
 * `meta.actionCard` of an agent's proposal of a new agent (ADR 0080). Unlike the Connect card it keeps its
 * state: what a person decided can't come from live data. Only the decision routes write it, each from the
 * state it expects (`creating` holds it while the agent is made).
 */
export interface AgentProposalCard {
  kind: "agent_proposal";
  /** The person behind the run that proposed it; null when nobody was. */
  forUserId: string | null;
  params: { draft: AgentDraft; why: string };
  state: AgentProposalState;
  /** The agent made from it. */
  agentId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  /** Past it, a pending proposal is expired (not stored). */
  expiresAt: string;
}

export interface AgentProposalView extends AgentProposalCard {
  messageId: string;
  channelId: string;
  threadId: string | null;
  proposedByAgentId: string;
  expired: boolean;
  /** The viewer may create it or say no (it is open and they may create agents). */
  canDecide: boolean;
}

export interface AgentProposalDeps {
  db: Database;
  pubsub?: PubSub;
}

export const agentProposalOf = (meta: Record<string, unknown> | null | undefined): AgentProposalCard | null => {
  const card = meta?.actionCard as Partial<AgentProposalCard> | undefined;
  return card?.kind === "agent_proposal" && card.params?.draft ? (card as AgentProposalCard) : null;
};

const expired = (card: AgentProposalCard, now = Date.now()) =>
  card.state === "pending" && Date.parse(card.expiresAt) <= now;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v : []);

/** What the tool takes (the Tool Gateway already checked its JSON Schema). */
export interface AgentDraftInput {
  name?: unknown;
  handle?: unknown;
  role?: unknown;
  instructions?: unknown;
  look?: unknown;
  channels?: unknown;
  access?: unknown;
}

/**
 * The draft checked as the create-agent API checks an agent: the name, a free handle of the right shape, the
 * role, the instructions and the look; plus the channels it joins (public ones, by name) and its access to the
 * workspace's connected apps (by catalog id or name). The AI is suggested apart (`suggestAgentAi`).
 */
export async function checkAgentDraft(
  db: Database,
  orgId: string,
  input: AgentDraftInput,
): Promise<Omit<AgentDraft, "ai">> {
  const name = str(input.name);
  if (!name || name.length > 80) throw new ValidationError("Give it a name of up to 80 characters.");
  const handle = str(input.handle).replace(/^@/, "").toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) {
    throw new ValidationError("The handle must be 2–32 characters: lower-case letters, digits, - or _.");
  }
  const [agentTaken, personTaken] = await Promise.all([
    db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.handle, handle))),
    db
      .select({ id: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.handle, handle))),
  ]);
  if (agentTaken.length > 0 || personTaken.length > 0) {
    throw new ValidationError(`@${handle} is already taken: pick another handle.`);
  }
  const role = str(input.role);
  if (role.length > 200) throw new ValidationError("Keep the role under 200 characters.");
  const instructions = str(input.instructions);
  if (!instructions || instructions.length > 50_000) {
    throw new ValidationError("Say what it does in `instructions` (up to 50,000 characters).");
  }
  const appearance = input.look && typeof input.look === "object" ? validateAppearance(input.look) : null;

  const wanted = [...new Set(list(input.channels).map((c) => str(c).replace(/^#/, "").toLowerCase()))].filter(Boolean);
  // Public channels only: the card shows their names to everyone in this conversation.
  const open = await db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.kind, "channel"),
        eq(channels.visibility, "public"),
        isNull(channels.dmKey),
        isNull(channels.archivedAt),
      ),
    )
    .orderBy(asc(channels.name));
  const unknownChannels = wanted.filter((n) => !open.some((c) => c.name === n));
  if (unknownChannels.length > 0) {
    throw new ValidationError(
      `No public channel ${unknownChannels.map((n) => `#${n}`).join(", ")}. Public channels: ${open.map((c) => `#${c.name}`).join(", ") || "none"}.`,
    );
  }

  const connected = await db
    .select({
      id: connectorConnections.id,
      connector: connectorConnections.connector,
      label: connectorConnections.label,
    })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.orgId, orgId), isNull(connectorConnections.revokedAt)));
  const access = new Map<string, "read" | "write">();
  for (const raw of list(input.access)) {
    const entry = (raw && typeof raw === "object" ? raw : {}) as { connector?: unknown; level?: unknown };
    const wantedApp = str(entry.connector).toLowerCase();
    const found = connected.find((c) => c.connector.toLowerCase() === wantedApp || c.label.toLowerCase() === wantedApp);
    if (!found) {
      throw new ValidationError(
        `No connected app "${wantedApp}". Connected: ${connected.map((c) => c.connector).join(", ") || "none"}.`,
      );
    }
    access.set(found.id, entry.level === "write" ? "write" : "read");
  }

  return {
    name,
    handle,
    role,
    instructions,
    appearance,
    channelIds: open.filter((c) => wanted.includes(c.name)).map((c) => c.id),
    access: [...access].map(([connectionId, level]) => ({ connectionId, level })),
  };
}

/**
 * The AI the draft suggests (ADR 0080): the first account of `userId`'s that thinks for no agent (an active
 * sign-in on a computer still there), else the workspace's model when a new agent on it would have a key, else
 * none. A plan thinks only for its owner's agents (ADR 0059 §3), so an account is suggested only to someone who
 * may create the agent and own it.
 */
export async function suggestAgentAi(
  deps: { db: Database; gateway?: AiStatusDeps["gateway"] },
  orgId: string,
  userId: string | null,
): Promise<SuggestedAi> {
  if (userId && (await mayCreateAgents(deps.db, orgId, userId))) {
    const used = deps.db
      .select({ id: agents.brainAccountId })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNotNull(agents.brainAccountId)));
    const [free] = await deps.db
      .select({
        id: machineAccounts.id,
        kind: machineAccounts.kind,
        label: machineAccounts.label,
        machineId: machineAccounts.machineId,
      })
      .from(machineAccounts)
      .innerJoin(machines, and(eq(machines.id, machineAccounts.machineId), isNull(machines.deletedAt)))
      .where(
        and(
          eq(machineAccounts.orgId, orgId),
          eq(machineAccounts.createdBy, userId),
          eq(machineAccounts.status, "active"),
          inArray(machineAccounts.kind, ["claude_code", "codex"]),
          notInArray(machineAccounts.id, used),
        ),
      )
      .orderBy(asc(machineAccounts.createdAt))
      .limit(1);
    if (free) {
      return {
        kind: "account",
        brain: free.kind === "codex" ? "codex" : "claude_code",
        machineId: free.machineId,
        accountId: free.id,
        label: free.label,
      };
    }
  }
  if (deps.gateway) {
    // A new agent as the create-agent screen makes it: "Automático" on the workspace's default key.
    const fresh: Parameters<typeof agentAiState>[1] = {
      orgId,
      model: AUTO_MODEL,
      credentialId: null,
      brain: "model",
      brainFallback: false,
      brainAccountId: null,
      machineId: null,
    };
    if ((await agentAiState({ db: deps.db, gateway: deps.gateway }, fresh)).state === "ready") return { kind: "model" };
  }
  return { kind: "none" };
}

/** Whether this person may create agents (`manage_agents`), and so own the new one and give it their plan. */
export async function mayCreateAgents(db: Database, orgId: string, userId: string | null) {
  const membership = userId ? await getMembership(db, userId, orgId) : null;
  return membership !== null && can(membership.role, "manage_agents");
}

/** The proposal behind a card message the viewer can read, or 404. */
async function proposalMessage(db: Database, userId: string, orgId: string, messageId: string) {
  const message = await getMessage(db, orgId, messageId);
  const card = message && !message.deletedAt && message.authorType === "agent" ? agentProposalOf(message.meta) : null;
  if (!message || !card || !message.authorAgentId) {
    throw new NotFoundError("Proposal not found", "agent_proposal.not_found");
  }
  const { membership } = await requireChannelAccess(db, userId, orgId, message.channelId);
  return { message, card, proposedBy: message.authorAgentId, membership };
}

const view = (
  message: Message,
  card: AgentProposalCard,
  proposedByAgentId: string,
  mayCreate: boolean,
): AgentProposalView => {
  const gone = expired(card);
  return {
    ...card,
    messageId: message.id,
    channelId: message.channelId,
    threadId: message.threadId,
    proposedByAgentId,
    expired: gone,
    canDecide: mayCreate && card.state === "pending" && !gone,
  };
};

/**
 * `GET …/agent-proposals/{messageId}`: the card's draft and state, for whoever reads its conversation. While the
 * viewer may decide, the AI is suggested for them, now: an account suggested to the asker is the asker's alone.
 */
export async function getAgentProposal(
  deps: { db: Database; gateway?: AiStatusDeps["gateway"] },
  userId: string,
  orgId: string,
  messageId: string,
) {
  const { message, card, proposedBy, membership } = await proposalMessage(deps.db, userId, orgId, messageId);
  const shown = view(message, card, proposedBy, can(membership.role, "manage_agents"));
  if (!shown.canDecide) return shown;
  const draft = { ...card.params.draft, ai: await suggestAgentAi(deps, orgId, userId) };
  return { ...shown, params: { ...card.params, draft } };
}

/** Writes the card if it is still in state `from`: two people deciding at once, only one gets it. */
async function setCard(db: Database, message: Message, card: AgentProposalCard, from: AgentProposalState) {
  const [row] = await db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(card)}::jsonb)` })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.orgId, message.orgId),
        sql`${messages.meta}->'actionCard'->>'state' = ${from}`,
      ),
    )
    .returning({ id: messages.id });
  return row !== undefined;
}

/** Only who may create agents decides (the create-agent rule), only while it is open. */
async function claim(
  deps: AgentProposalDeps,
  userId: string,
  orgId: string,
  messageId: string,
  to: "creating" | "denied",
) {
  const found = await proposalMessage(deps.db, userId, orgId, messageId);
  await requirePermission(deps.db, userId, orgId, "manage_agents");
  // A crash between this claim and the agent leaves it `creating`, decided for good (as the forum's suggestions).
  const decided = () => new ConflictError("This proposal was already decided", "agent_proposal.decided");
  if (found.card.state !== "pending") throw decided();
  if (expired(found.card)) throw new ConflictError("This proposal expired", "agent_proposal.expired");
  const next: AgentProposalCard = {
    ...found.card,
    state: to,
    decidedByUserId: userId,
    decidedAt: new Date().toISOString(),
  };
  if (!(await setCard(deps.db, found.message, next, "pending"))) throw decided();
  return { ...found, card: next, before: found.card };
}

/** Everyone in the conversation sees the card change; the agent that proposed it is told (a notice). */
async function settle(
  deps: AgentProposalDeps,
  found: { message: Message; card: AgentProposalCard; proposedBy: string },
  userId: string,
  agent: Agent | null,
) {
  const { message, card } = found;
  await publishChannelEvent(deps.pubsub, {
    type: "agent.proposal.updated",
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
    card: card as unknown as Record<string, unknown>,
  });
  const [run] = message.agentRunId
    ? await deps.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, message.orgId), eq(agentRuns.id, message.agentRunId)))
    : [];
  if (!run) return;
  const [person] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const who = person?.name ?? "A person";
  const notice: Notice = {
    kind: "proposal_result",
    from: `Your proposal of the agent «${card.params.draft.name}»`,
    text: agent
      ? `${who} created it: @${agent.handle} (${agent.name}). It is on the team now.`
      : `${who} said no. Don't propose it again unless someone asks.`,
    refs: { messageId: message.id, ...(agent ? { agentId: agent.id } : {}) },
  };
  const delivered = await deps.db.transaction((tx) => deliverNoticeToRun(tx, run, notice));
  await publishDelivery(deps.pubsub, delivered).catch(() => {});
}

/**
 * Creates the agent a card proposed, with what the person edited (`create`, under their own permission: it
 * calls `createAgent` as them). The card is held while it runs and goes back to pending if it fails.
 */
export async function createAgentFromProposal(
  deps: AgentProposalDeps,
  userId: string,
  orgId: string,
  messageId: string,
  create: () => Promise<Agent>,
): Promise<Agent> {
  const found = await claim(deps, userId, orgId, messageId, "creating");
  let agent: Agent;
  try {
    agent = await create();
  } catch (error) {
    await setCard(deps.db, found.message, found.before, "creating");
    throw error;
  }
  const card: AgentProposalCard = { ...found.card, state: "created", agentId: agent.id };
  await setCard(deps.db, found.message, card, "creating");
  await settle(deps, { ...found, card }, userId, agent);
  return agent;
}

/** "Recusar": the card stays, marked denied, and the agent that proposed it is told. */
export async function denyAgentProposal(deps: AgentProposalDeps, userId: string, orgId: string, messageId: string) {
  const found = await claim(deps, userId, orgId, messageId, "denied");
  await settle(deps, found, userId, null);
  return view(found.message, found.card, found.proposedBy, true);
}
