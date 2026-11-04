import type { PubSub } from "@agenteschat/adapters";
import { and, count, eq, schema, sql } from "@agenteschat/db";
import { isKnownProvider, PROVIDERS } from "@agenteschat/providers";
import { actWithUndo } from "./agent-actions";
import {
  AGENT_PROPOSAL_CARD,
  type AgentProposalCard,
  checkAgentDraft,
  deciderCanOpen,
  mayCreateAgents,
  type SuggestedAi,
  suggestAgentAi,
} from "./agent-proposals";
import { agentsByHandle, getAgentCached } from "./agents";
import type { AiStatusDeps } from "./ai-status";
import { AGENT_LOOK } from "./appearance";
import { addChannelMember, createChannel } from "./channels";
import { findMember } from "./chat-tools";
import { CONNECTOR_CATALOG } from "./connectors/catalog";
import { connectorListing, type ServerCatalog } from "./connectors/listing";
import { MCP_PRESETS, presetForServer } from "./connectors/presets";
import type { ContextDeps } from "./context/summaries";
import { publishMessageCreated } from "./events";
import { insertMessage, messageView } from "./messages";
import { can, getMembership } from "./organizations";
import type { RolePermission } from "./permissions";
import { personBehindCall } from "./requester";
import { bodyCode } from "./run-tools";
import { replyThreadOf } from "./runs";
import { REPORT_SCHEMA, SCHEDULE_INPUT } from "./schedule-tools";
import { noAgentText } from "./team";
import { APPROVAL_TTL_MS } from "./tools/gateway";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const { agentActions, agentRuns, messages } = schema;

/** The setup tools' scope: a tool group of its own, loaded when a message is about setting up (ADR 0043). */
export const SETUP_SCOPE = "setup:write";
export const OFFER_CONNECT_AI_TOOL = "offer_connect_ai";
export const CREATE_CHANNEL_TOOL = "create_channel";
export const PROPOSE_AGENT_TOOL = "propose_agent";
export const OFFER_CONNECT_APP_TOOL = "offer_connect_app";
export const OFFER_INVITES_TOOL = "offer_invites";
/** What one run may make: enough for a request, never a flood (also all a prompt injection gets). */
export const MAX_CARDS_PER_RUN = 3;
export const MAX_CHANNELS_PER_RUN = 5;
/** A Connect card's `bodyCode` (the apps say it with `chat.body.action_connect_ai`). */
export const CONNECT_AI_CARD = "action_connect_ai";
/** A connect-an-app card's `bodyCode` (`chat.body.action_connect_app`, with `name`); one with no name, `ADD_MCP_CARD`. */
export const CONNECT_APP_CARD = "action_connect_app";
export const ADD_MCP_CARD = "action_add_mcp";
/** An invite card's `bodyCode` (`chat.body.action_invite_people`). */
export const INVITE_CARD = "action_invite_people";
/** Addresses one invite card fills in. */
export const MAX_INVITES_PER_CARD = 20;

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

/**
 * "Conectar Linear" or "Adicionar MCP": its button opens the app's own connect dialog, at the catalog entry (`connector`)
 * or at "connect by address" with `url` filled in (none: the person types it). Done from live data: a connection to it.
 */
export interface ConnectAppCard {
  kind: "connect_app";
  forUserId: string | null;
  params: { connector?: string; url?: string; why: string };
}

/** "Convidar pessoas": its button opens the app's invite dialog with the addresses filled in, as members. */
export interface InviteCard {
  kind: "invite_people";
  forUserId: string | null;
  params: { emails: string[]; why: string };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A catalog connector or one-click MCP server by its id or name ("GitHub", "google-drive"). With `server`, as this
 * server's "Adicionar conector" lists it, whether it connects here (`soon`: its vendor hasn't approved agentes.chat).
 */
export function catalogConnector(
  name: string,
  server?: ServerCatalog,
): { id: string; label: string; available: boolean; soon: boolean } | null {
  const key = slug(name);
  if (!key) return null;
  const all = server
    ? connectorListing(server)
    : [...Object.values(CONNECTOR_CATALOG), ...MCP_PRESETS].map((c) => ({ ...c, available: true, soon: false }));
  const hit = all.find((c) => slug(c.id) === key) ?? all.find((c) => slug(c.label) === key);
  return hit ? { id: hit.id, label: hit.label, available: hit.available, soon: hit.soon } : null;
}

/** Names of what "Adicionar conector" connects outside the catalog list: a mailbox (Email) or a database. */
const MAILBOX_NAMES = new Set([
  "email",
  "mail",
  "gmail",
  "outlook",
  "hotmail",
  "icloud",
  "yahoo",
  "imap",
  "mailbox",
  "inbox",
]);
const DATABASE_NAMES = new Set(["database", "db", "postgres", "postgresql", "banco", "bancodedados"]);

/** An MCP server's address as a card may carry it: https, with no user or password in it. */
export function mcpAddress(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether the person behind the run may do it themselves, and else whether someone who may can open this
 * conversation (so the card is still of use): what the tool tells the agent to say.
 */
export async function whoActs(ctx: ToolContext, userId: string | null, permission: RolePermission) {
  const membership = userId ? await getMembership(ctx.db, userId, ctx.orgId) : null;
  if (can(membership, permission)) return "person" as const;
  return (await deciderCanOpen(ctx.db, ctx.orgId, ctx.channelId, permission)) ? ("admin_here" as const) : null;
}
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});
const noAgents = async (ctx: ToolContext, missing: string[]): Promise<ToolOutput> => ({
  content: await noAgentText(ctx, missing),
  isError: true,
});

export async function hopOf(ctx: ToolContext) {
  const [run] = await ctx.db.select({ hop: agentRuns.hop }).from(agentRuns).where(eq(agentRuns.id, ctx.runId));
  return run?.hop ?? 0;
}

/** The run's cards so far (Connect cards and proposals alike), or an error once it has made its share. */
export async function cardsLeft(ctx: ToolContext): Promise<ToolOutput | null> {
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
 * - `propose_agent` (ADR 0081): a new agent is a card a person reviews, edits and creates (or says no to)
 *   with their own right to create agents. The tool creates nothing.
 */
export function createSetupToolSource(deps: {
  pubsub?: PubSub;
  /** The model gateway's key check, for the AI a proposed agent starts with. */
  ai?: { gateway: AiStatusDeps["gateway"] };
  /** Reads the schedule of the routine a proposed agent comes with (cron needs none). */
  context?: ContextDeps;
  /** What this server connects, so a card never offers a service it can't (none: the whole catalog). */
  catalog?: ServerCatalog;
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
              "A Claude plan (Pro, Max, Ultra, Team, Enterprise), a ChatGPT plan (Plus, Pro, Business, Enterprise) or an API key. Gemini works only with an API key: Google's plans can't be used in other products. Leave it out when the person didn't say: the card offers them all.",
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
          if (named.missing.length > 0) return noAgents(ctx, named.missing);
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
          if (agents.missing.length > 0) return noAgents(ctx, agents.missing);
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
        "Propose a new agent for the team with one card in this conversation: a person creates it in one click (or reviews and edits it first), or says no. Use it when someone asks for a new agent or bot, or when work needs a role nobody on the team has. Put in this one call everything the request implies, so the agent works as soon as it is created: the channels it joins, its access to the connected apps and to the asker's own mailbox (by its address) when the job reads or sends their email, and `routine` when the job runs on a schedule ('todo dia ao meio-dia'). It creates nothing: never say the agent exists until you are told it was created. The card suggests an AI for it by itself.",
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
          role: {
            type: "string",
            maxLength: 200,
            description:
              "What it does for the team, said plainly in the person's language (e.g. Email and calendar assistant).",
          },
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
            description:
              "Channels it joins, by name (e.g. design): public ones, and private ones of the person who asked that everyone here is in (this conversation, when it should work here). Its routine's conversation is added by itself.",
          },
          access: {
            type: "array",
            items: {
              type: "object",
              properties: {
                connector: {
                  type: "string",
                  minLength: 1,
                  maxLength: 320,
                  description:
                    "A connected app (github, linear…) or a mailbox of the person who asked, by its address.",
                },
                level: { type: "string", enum: ["read", "write"] },
              },
              required: ["connector", "level"],
              additionalProperties: false,
            },
            maxItems: 20,
            description:
              "What it may use of the apps the workspace connected and of the asker's mailboxes. Writing that matters still asks a person. Only a mailbox's owner gives an agent access to it.",
          },
          routine: {
            type: "object",
            description:
              "Work it does on its own on a schedule, created with it: each run gets `prompt` and reports in this conversation (in a DM, in its creator's DM with it).",
            properties: {
              schedule: SCHEDULE_INPUT,
              prompt: {
                type: "string",
                minLength: 1,
                maxLength: 10_000,
                description: "What each run does, in the person's language.",
              },
              title: { type: "string", maxLength: 120 },
              report: REPORT_SCHEMA,
            },
            required: ["schedule", "prompt"],
            additionalProperties: false,
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
          if (!(await deciderCanOpen(ctx.db, ctx.orgId, ctx.channelId))) {
            return {
              content:
                "Nothing was posted: nobody who may create agents can open this conversation, so nobody could decide the card. Tell the person that an admin or owner creates agents: they can ask one, or ask you again in a public channel.",
              isError: true,
            };
          }
          const forUserId = await personBehindCall(ctx);
          const place = { orgId: ctx.orgId, channelId: ctx.channelId, personId: forUserId };
          const draft = {
            ...(await checkAgentDraft({ db: ctx.db, context: deps.context }, place, input)),
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
            content: `Posted the proposal of ${draft.name} (@${draft.handle}). A person creates it from the card, in one click or after reviewing it: nothing exists until they do, and you'll be told what they decided and what it got.${(await mayCreateAgents(ctx.db, ctx.orgId, forUserId)) ? "" : " The person who asked can't create agents: an admin or owner reviews it."}${draft.routine ? ` Its routine «${draft.routine.name}» runs: ${draft.routine.description}.` : ""} Suggested AI: ${aiWords(draft.ai)}.`,
            data: { agentProposal: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: OFFER_CONNECT_APP_TOOL,
      description:
        "Offer to connect an app or an MCP server with a card in this conversation: its button opens the app's own connect dialog (sign-in or key, then its tools and which agents use it). Use it when a person asks to connect a service ('conecta o Linear', 'connect https://mcp.acme.com/mcp', 'add an MCP', 'adicionar MCP'). Pass `app` for a service by name, or `url` for an MCP server's address. When they want an MCP server and gave no address, ask for it in one short line first, or post the card without one and its dialog asks. Never ask for keys, tokens or passwords in the chat: the person types them in the dialog.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          app: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "A service by name or id (GitHub, Linear, Notion…).",
          },
          url: {
            type: "string",
            minLength: 9,
            maxLength: 2000,
            description: "An MCP server's https address, as the person gave it.",
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
          const rawUrl = str(input.url).trim();
          const url = rawUrl ? mcpAddress(rawUrl) : null;
          if (rawUrl && !url) {
            return {
              content:
                "That address can't be connected: it must start with https:// and carry no user or password. Ask the person for the server's https address.",
              isError: true,
            };
          }
          const app = str(input.app).trim();
          // A one-click server's address is that service: the card shows its name and icon.
          const preset = url ? presetForServer(url) : null;
          const listed = app && !url ? catalogConnector(app, deps.catalog) : null;
          const known = preset ? { id: preset.id, label: preset.label } : listed;
          if (app && !url && !listed) {
            const where = MAILBOX_NAMES.has(slug(app)) ? "Email" : DATABASE_NAMES.has(slug(app)) ? "Database" : null;
            return {
              content: where
                ? `This isn't connected with a card: a person who manages connectors does it in Settings › Connectors and MCPs › Add connector › ${where} (in Portuguese, Configurações › Conectores e MCPs › Adicionar conector › ${where === "Email" ? "Email" : "Banco de dados"}). Tell the person exactly this.`
                : `"${app}" isn't in the catalog. Ask the person for its MCP server's https address and pass it as \`url\`.`,
              isError: true,
            };
          }
          if (listed && !listed.available) {
            return {
              content: listed.soon
                ? `${listed.label} doesn't let agentes.chat connect in one click yet. If it gives an API key, ask the person for its MCP server's https address and pass it as \`url\` (the dialog asks for the key).`
                : `${listed.label} isn't available on this installation: whoever runs it has to turn it on first. Tell the person.`,
              isError: true,
            };
          }
          const forUserId = await personBehindCall(ctx);
          const acts = await whoActs(ctx, forUserId, "manage_connectors");
          if (!acts) {
            return {
              content:
                "Nothing was posted: connecting apps is for admins, and none of them can open this conversation. Tell the person an admin connects it, and offer to ask one (request_approval, or in a channel an admin reads).",
              isError: true,
            };
          }
          const full = await cardsLeft(ctx);
          if (full) return full;
          const card: ConnectAppCard = {
            kind: "connect_app",
            forUserId,
            params: { ...(known ? { connector: known.id } : {}), ...(url && !preset ? { url } : {}), why },
          };
          const name = known?.label ?? (url ? new URL(url).host : null);
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            channelId: ctx.channelId,
            threadId: replyThreadOf(ctx),
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
            body: `Connect ${name ?? "an MCP server"}: ${why}`,
            meta: { ...(name ? bodyCode(CONNECT_APP_CARD, { name }) : bodyCode(ADD_MCP_CARD)), actionCard: card },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          return {
            content: `Posted the card to connect ${name ?? "an MCP server"}: a person signs in or adds its key in the app's dialog, then picks its tools and which agents use it.${acts === "person" ? "" : " The person who asked can't connect apps: an admin here does it from the card. Say so, and offer to ask one."} Don't ask for keys or tokens here, and don't say it's connected until you can use its tools.`,
            data: { actionCard: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: OFFER_INVITES_TOOL,
      description:
        "Offer to invite people to the workspace with a card in this conversation: its button opens the app's invite dialog with these addresses filled in, as members. A person who may invite sends it there (and may change roles); you send nothing. Use it when someone asks to invite or add people by email.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          emails: {
            type: "array",
            items: { type: "string", minLength: 3, maxLength: 254 },
            minItems: 1,
            maxItems: MAX_INVITES_PER_CARD,
          },
          why: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description:
              "One short line on the card for the person, in their language: who they are or why invite them.",
          },
        },
        required: ["emails", "why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const why = str(input.why).trim();
          if (!why) return { content: "Say in `why` why to invite them: one short line.", isError: true };
          const emails = [
            ...new Set((Array.isArray(input.emails) ? input.emails : []).map((e) => str(e).trim().toLowerCase())),
          ];
          const bad = emails.filter((e) => !EMAIL.test(e));
          if (bad.length > 0) return { content: `Not an email address: ${bad.join(", ")}.`, isError: true };
          const forUserId = await personBehindCall(ctx);
          if (!forUserId) return { content: "Only a person's request can lead to invitations.", isError: true };
          const acts = await whoActs(ctx, forUserId, "invite_people");
          if (!acts) {
            return {
              content:
                "Nothing was posted: the person who asked can't invite people, and nobody who can opens this conversation. Tell them an admin invites, and offer to ask one.",
              isError: true,
            };
          }
          const full = await cardsLeft(ctx);
          if (full) return full;
          const card: InviteCard = { kind: "invite_people", forUserId, params: { emails, why } };
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            channelId: ctx.channelId,
            threadId: replyThreadOf(ctx),
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
            body: `Invite ${emails.join(", ")}: ${why}`,
            meta: { ...bodyCode(INVITE_CARD), actionCard: card },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          return {
            content: `Posted the invite card for ${emails.join(", ")}: nobody is invited until a person sends it from the dialog.${acts === "person" ? "" : " The person who asked can't invite: someone who may does it from the card. Say so."}`,
            data: { actionCard: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "setup", tools: async () => tools };
}
