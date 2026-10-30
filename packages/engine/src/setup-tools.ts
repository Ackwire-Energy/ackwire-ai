import type { PubSub } from "@agenteschat/adapters";
import { and, count, eq, schema, sql } from "@agenteschat/db";
import { isKnownProvider, PROVIDERS } from "@agenteschat/providers";
import { actWithUndo } from "./agent-actions";
import {
  AGENT_PROPOSAL_CARD,
  type AgentProposalCard,
  checkAgentDraft,
  mayCreateAgents,
  type SuggestedAi,
  suggestAgentAi,
} from "./agent-proposals";
import { agentsByHandle, getAgentCached } from "./agents";
import type { AiStatusDeps } from "./ai-status";
import { AGENT_LOOK } from "./appearance";
import { addChannelMember, createChannel } from "./channels";
import { findMember } from "./chat-tools";
import { publishMessageCreated } from "./events";
import { insertMessage, messageView } from "./messages";
import { personBehindCall } from "./requester";
import { bodyCode } from "./run-tools";
import { replyThreadOf } from "./runs";
import { APPROVAL_TTL_MS } from "./tools/gateway";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const { agentActions, agentRuns, messages } = schema;

/** The setup tools' scope: a tool group of its own, loaded when a message is about setting up (ADR 0043). */
export const SETUP_SCOPE = "setup:write";
export const OFFER_CONNECT_AI_TOOL = "offer_connect_ai";
export const CREATE_CHANNEL_TOOL = "create_channel";
export const PROPOSE_AGENT_TOOL = "propose_agent";
/** What one run may make: enough for a request, never a flood (also all a prompt injection gets). */
export const MAX_CARDS_PER_RUN = 3;
export const MAX_CHANNELS_PER_RUN = 5;
/** A Connect card's `bodyCode` (the apps say it with `chat.body.action_connect_ai`). */
export const CONNECT_AI_CARD = "action_connect_ai";

export type ConnectAiStep = "claude" | "chatgpt" | "api_key";

const STEPS: Record<ConnectAiStep, string> = {
  claude: "a Claude plan",
  chatgpt: "a ChatGPT plan",
  api_key: "an API key",
};

/**
 * `meta.actionCard` of an agent's card (ADR 0061): its button opens the app's own dialog, filled in. It
 * keeps no state: the app tells it's done from live data (its agents can think; for a plan, with that plan).
 */
export interface ActionCard {
  kind: "connect_ai";
  /** The person behind the run that offered it; null when nobody was. */
  forUserId: string | null;
  params: {
    /** The dialog's step; none = its first one (a plan or a key). */
    what?: ConnectAiStep;
    /** With `api_key`: the catalog provider. */
    provider?: string;
    /** The agents to connect; none = any agent the person may change. */
    agentIds: string[];
    /** The agent's line for the person, in their language. */
    why: string;
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});
const noAgents = (missing: string[]): ToolOutput => ({
  content: `No agent ${missing.map((h) => `@${h}`).join(", ")} in this organization.`,
  isError: true,
});

async function hopOf(ctx: ToolContext) {
  const [run] = await ctx.db.select({ hop: agentRuns.hop }).from(agentRuns).where(eq(agentRuns.id, ctx.runId));
  return run?.hop ?? 0;
}

/** The run's cards so far (Connect cards and proposals alike), or an error once it has made its share. */
async function cardsLeft(ctx: ToolContext): Promise<ToolOutput | null> {
  const [made] = await ctx.db
    .select({ n: count() })
    .from(messages)
    .where(
      and(eq(messages.orgId, ctx.orgId), eq(messages.agentRunId, ctx.runId), sql`${messages.meta} ? 'actionCard'`),
    );
  return (made?.n ?? 0) >= MAX_CARDS_PER_RUN
    ? { content: `You already offered ${MAX_CARDS_PER_RUN} cards in this turn.`, isError: true }
    : null;
}

/** How the tool result names the suggested AI to the agent. */
const aiWords = (ai: SuggestedAi) =>
  ai.kind === "account"
    ? `${ai.label}, an account of theirs that thinks for no agent`
    : ai.kind === "model"
      ? "the workspace's model"
      : "none yet: the person connects one after creating it";

/**
 * Setting up the workspace from the chat, "anything the app can do" (ADR 0061 §8), under `setup:write`:
 * - `offer_connect_ai`: what needs a person's credentials or consent becomes a card in this conversation
 *   whose button opens the app's own dialog, filled in. The agent never holds a key or a sign-in.
 * - `create_channel`: internal and reversible, so it acts right away for the person who asked, with
 *   their rights, and the reply carries a receipt with Undo (archive).
 * - `propose_agent` (ADR 0080): a new agent is a card a person reviews, edits and creates (or says no to)
 *   with their own right to create agents. The tool creates nothing.
 */
export function createSetupToolSource(deps: {
  pubsub?: PubSub;
  /** The model gateway's key check, for the AI a proposed agent starts with. */
  ai?: { gateway: AiStatusDeps["gateway"] };
}): ToolSource {
  const tools: ToolDefinition[] = [
    {
      name: OFFER_CONNECT_AI_TOOL,
      description:
        "Offer to connect an AI with a card in this conversation: its Connect button opens the app's own dialog at that step (a Claude plan, a ChatGPT plan or an API key) for the agents you name. Use it when a person asks to connect or switch an AI ('usar meu plano do Claude', 'add my OpenAI key'), or when an agent has none. A person connects it in the dialog: never ask for keys, passwords or sign-in codes in the chat.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          what: {
            type: "string",
            enum: Object.keys(STEPS),
            description:
              "A Claude plan (Pro, Max, Team, Enterprise), a ChatGPT plan (Plus, Pro, Business, Enterprise) or an API key. Gemini works only with an API key: Google's plans can't be used in other products. Leave it out when the person didn't say: the card offers them all.",
          },
          provider: {
            type: "string",
            enum: Object.keys(PROVIDERS),
            description: "With `api_key`: whose key it is.",
          },
          agents: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
            maxItems: 10,
            description:
              "@handles of the agents to connect (a plan thinks for one agent). Default: you, for a plan; for a key, none (keys are the organization's).",
          },
          why: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description: "One short line on the card for the person, in their language: why connect it.",
          },
        },
        required: ["why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const why = str(input.why).trim();
          if (!why) return { content: "Say in `why` why to connect it: one short line.", isError: true };
          const what = Object.hasOwn(STEPS, str(input.what)) ? (input.what as ConnectAiStep) : undefined;
          const provider = what === "api_key" && isKnownProvider(str(input.provider)) ? str(input.provider) : "";
          const named = await agentsByHandle(ctx.db, ctx.orgId, input.agents);
          if (named.missing.length > 0) return noAgents(named.missing);
          let targets = named.rows;
          if (targets.length === 0 && (what === "claude" || what === "chatgpt")) {
            const self = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
            if (self) targets = [{ id: self.id, handle: self.handle, name: self.name }];
          }
          const full = await cardsLeft(ctx);
          if (full) return full;
          const card: ActionCard = {
            kind: "connect_ai",
            forUserId: await personBehindCall(ctx),
            params: {
              ...(what ? { what } : {}),
              ...(provider ? { provider } : {}),
              agentIds: targets.map((a) => a.id),
              why,
            },
          };
          const names = targets.map((a) => a.name).join(", ");
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            channelId: ctx.channelId,
            threadId: replyThreadOf(ctx),
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
            body: `Connect ${what ? STEPS[what] : "an AI"}${names ? ` for ${names}` : ""}: ${why}`,
            meta: { ...bodyCode(CONNECT_AI_CARD), actionCard: card },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          return {
            content: `Posted the card${names ? ` for ${names}` : ""}: a person connects it from its button. Tell them in your reply; don't ask for keys or codes here.`,
            data: { actionCard: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: CREATE_CHANNEL_TOOL,
      description:
        "Create a channel when a person asks for one, with their rights, and add people (@handle, email or name) and agents (@handles) to it; the person who asked is always in it. No permission needed: the person sees it under your reply with Undo.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 81,
            description: "Lower-case letters, digits, - or _ (e.g. launch-q4), with or without #.",
          },
          topic: { type: "string", maxLength: 500, description: "What the channel is for." },
          people: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 20 },
          agents: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
            maxItems: 10,
            description: "Include yourself if you should be there.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const requester = await personBehindCall(ctx);
          if (!requester) return { content: "Only a person's request can create a channel.", isError: true };
          const [made] = await ctx.db
            .select({ n: count() })
            .from(agentActions)
            .where(
              and(
                eq(agentActions.orgId, ctx.orgId),
                eq(agentActions.runId, ctx.runId),
                eq(agentActions.kind, "channel.created"),
              ),
            );
          if ((made?.n ?? 0) >= MAX_CHANNELS_PER_RUN) {
            return { content: `You already created ${MAX_CHANNELS_PER_RUN} channels in this turn.`, isError: true };
          }
          const agents = await agentsByHandle(ctx.db, ctx.orgId, input.agents);
          if (agents.missing.length > 0) return noAgents(agents.missing);
          const people = new Map<string, string>();
          for (const who of Array.isArray(input.people) ? input.people.map(str) : []) {
            const matches = await findMember(ctx, who);
            if (matches.length === 0) return { content: `No one called "${who}" in this organization.`, isError: true };
            if (matches.length > 1) {
              const names = matches.map((m) => (m.handle ? `${m.name} (@${m.handle})` : m.name)).join(", ");
              return { content: `Several people match "${who}": ${names}. Ask which one.`, isError: true };
            }
            const [person] = matches;
            if (person && person.userId !== requester) people.set(person.userId, person.name);
          }
          const channel = await actWithUndo(
            ctx,
            async (db) => {
              const created = await createChannel(db, requester, ctx.orgId, {
                name: str(input.name).trim().replace(/^#/, ""),
                topic: str(input.topic).trim(),
              });
              // Agents first: only they can be refused (their owner or an admin adds them), and a refusal
              // undoes the whole channel before anyone was told they're in it.
              for (const a of agents.rows) {
                await addChannelMember(db, requester, ctx.orgId, created.id, { agentId: a.id }, deps);
              }
              for (const userId of people.keys()) {
                await addChannelMember(db, requester, ctx.orgId, created.id, { userId }, deps);
              }
              return created;
            },
            (created) => ({
              kind: "channel.created",
              target: { type: "channel", id: created.id, title: created.name },
              params: { name: created.name },
              before: null,
              after: { name: created.name },
            }),
          );
          const members = [...people.values(), ...agents.rows.map((a) => `@${a.handle}`)];
          return {
            content: `Created #${channel.name}${members.length ? ` with ${members.join(", ")}` : ""}.`,
            data: { channel: { id: channel.id, name: channel.name } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: PROPOSE_AGENT_TOOL,
      description:
        "Propose a new agent for the team with a card in this conversation: a person reviews it in the app, edits it and creates it, or says no. Use it when someone asks for a new agent or bot, or when work needs a role nobody on the team has. It creates nothing: never say the agent exists until you are told it was created. The card suggests an AI for it by itself.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80, description: "Its name, e.g. Ada." },
          handle: {
            type: "string",
            pattern: "^@?[a-z0-9][a-z0-9_-]{1,31}$",
            description: "Its @handle: 2–32 lower-case letters, digits, - or _ (e.g. ada).",
          },
          role: { type: "string", maxLength: 200, description: "What it is, in a few words (e.g. Designer)." },
          instructions: {
            type: "string",
            minLength: 1,
            maxLength: 50_000,
            description: "What it does and how: its standing instructions, in the person's language.",
          },
          look: {
            type: "object",
            properties: {
              color: { type: "string", enum: [...AGENT_LOOK.colors] },
              eyes: { type: "string", enum: [...AGENT_LOOK.eyes] },
              accessory: { type: "string", enum: [...AGENT_LOOK.accessories] },
            },
            required: ["color", "eyes"],
            additionalProperties: false,
          },
          channels: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 81 },
            maxItems: 20,
            description: "Public channels it joins, by name (e.g. design).",
          },
          access: {
            type: "array",
            items: {
              type: "object",
              properties: {
                connector: {
                  type: "string",
                  minLength: 1,
                  maxLength: 80,
                  description: "A connected app: github, linear…",
                },
                level: { type: "string", enum: ["read", "write"] },
              },
              required: ["connector", "level"],
              additionalProperties: false,
            },
            maxItems: 20,
            description:
              "What it may use of the apps the workspace connected. Writing that matters still asks a person.",
          },
          why: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description: "One short line on the card for the person, in their language: why this agent.",
          },
        },
        required: ["name", "handle", "instructions", "why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const why = str(input.why).trim();
          if (!why) return { content: "Say in `why` why this agent: one short line.", isError: true };
          const full = await cardsLeft(ctx);
          if (full) return full;
          const forUserId = await personBehindCall(ctx);
          const draft = {
            ...(await checkAgentDraft(ctx.db, ctx.orgId, input)),
            ai: await suggestAgentAi({ db: ctx.db, gateway: deps.ai?.gateway }, ctx.orgId, forUserId),
          };
          const card: AgentProposalCard = {
            kind: "agent_proposal",
            forUserId,
            params: { draft, why },
            state: "pending",
            agentId: null,
            decidedByUserId: null,
            decidedAt: null,
            expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
          };
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            channelId: ctx.channelId,
            threadId: replyThreadOf(ctx),
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
            body: `Proposed a new agent, ${draft.name}: ${why}`,
            meta: { ...bodyCode(AGENT_PROPOSAL_CARD, { name: draft.name }), actionCard: card },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          return {
            content: `Posted the proposal of ${draft.name} (@${draft.handle}). A person reviews it from the card: nothing exists until they create it, and you'll be told what they decided.${(await mayCreateAgents(ctx.db, ctx.orgId, forUserId)) ? "" : " The person who asked can't create agents: an admin or owner reviews it."} Suggested AI: ${aiWords(draft.ai)}.`,
            data: { agentProposal: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "setup", tools: async () => tools };
}
