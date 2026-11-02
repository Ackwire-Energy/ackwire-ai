import type { PubSub } from "@agenteschat/adapters";
import { and, count, type Database, eq, inArray, isNotNull, isNull, schema } from "@agenteschat/db";
import { type ArtifactDeps, createConversationArtifact, getArtifact, updateArtifact } from "./artifacts";
import { requireChannelAccess } from "./channels";
import { publishDelivery } from "./delivery";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { type MessageView, postPersonMessage } from "./messages";
import type { Notice } from "./notices";
import { can } from "./organizations";
import { enqueue } from "./outbox";
import { deliverNoticeToRun } from "./run-resume";
import { replyThreadOf } from "./runs";
import type { Talker } from "./talker";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const { agentRuns, agents, artifacts, channelMembers, channels, pollVotes, polls, users } = schema;

/**
 * What lives in a conversation and not in the Drive (ADR 0113). A file is for keeping; a block is for using now: a
 * small interactive thing in the agent's reply, and what the person picks comes back to the agent. A poll is the
 * same for several people, drawn by the apps themselves: a vote is an act of the person's, so no page may cast one.
 */

export const SHOW_BLOCK_TOOL = "show_block";
export const START_POLL_TOOL = "start_poll";
export const POLL_CLOSE_JOB = "poll.close";

const DEFAULT_POLL_HOURS = 24;
const MAX_POLL_HOURS = 7 * 24;
/** What a block can send back: the person reads it before it goes. */
export const BLOCK_REPLY_CHARS = 2000;

/** The manual an agent writes blocks from: every part of the kit (`packages/client/src/lib/block-kit.ts`). */
export const BLOCK_MANUAL = `A live block is a small interactive thing inside your reply: something the person uses now (a simulator, a filterable view, options to see side by side, a short form). Reports and documents are files, not blocks; a question with plain choices is ask_user.

Write short HTML, with no <html>, <head> or <body>. There is no network: no fetch, no CDN, no outside images. Put the data in the block. For passwords and keys use request_secret, never a block.

It must look like part of the app, in both light and dark:
- Build from the parts below. Plain HTML (headings, text, lists, links, inputs, selects, checkboxes, tables, progress) is already styled: leave it.
- Write CSS only for layout and for drawings the parts can't do. Never set a font, a shadow or a border radius.
- Never write a color. Use the variables below; a color written by hand breaks in the other theme.
- No tinted boxes, colored badges or status dots: a caveat is <ac-note>, and the option you recommend is <ac-card selected>.
- In a drawing, text stays upright at rest and sits inside its shape.
- Every word on it is in the person's language.

Parts (every input has a name; its value is in the state under that name):
- <ac-slider name label min max step value unit format>; format: brl (1200 is R$ 1.200), mil (12 is R$ 12 mil, so the value is in thousands), pct, int
- <ac-choice name label options="A|B|C" value> buttons, one choice; the first is chosen unless value="", which leaves none, as a quiz needs
- <ac-field name label type="text|number|date|textarea" placeholder>
- <ac-check name label checked> a switch
- <ac-stat label bind format unit sub sub-bind tone-bind> a big number; value for a fixed one; tone-bind reads "up" or "down"
- <ac-chart type="bar|line" bind label format unit select all> bind is an array of {label, value}; on bars, select="name" makes a click set that input (all is the value that clears it)
- <ac-table bind columns="Title:key:format|Title:key"> bind is an array of objects
- <ac-text bind format> a value inside text; {name} works only in <ac-send>
- <ac-note> small text; <ac-more label> text that opens
- <ac-card label sub selected> a card around anything; with name and value it becomes a choice: a click sets name to value and marks it
- <ac-result label bind format unit> the answer the block gives, large and centered; value for a fixed one
- <ac-actions align="center|start"> a row of buttons, with the right space around it; every button goes in one, and the only button showing is drawn as the main action
- <ac-row> side by side, also for cards; <ac-stats> a row of stats
- Any element: when="name=value" or when="name!=value" shows it only then

Script:
- agentes.compute(s => ({ ... })) derives values from the state s; they can be bound like inputs. It runs on every change.
- agentes.on(s => { ... }) runs on every change, for your own drawing.
- agentes.set(name, value) changes the state.
- CSS variables: --ink, --muted, --faint for text; --raised, --well, --sunken for surfaces; --line, --line2 for lines; --s1 to --s6 for categories, your own tones in order, with --on-s for text on them.

To get an answer, add <ac-send label="Use this" text="Text with {name} or {name:format}" needs="a,b" hint="Why it's disabled">. The app shows the text and the button outside the block and the person decides; it reaches you as their message. needs lists values that must be filled or true. Add it only when your next step depends on the answer.

When a number comes from your own formula, show how in <ac-more> and call it an estimate.

Example:
<ac-slider name="preco" label="Preço" min="50" max="200" step="10" value="100" format="brl"></ac-slider>
<ac-stat label="Margem" bind="margem" format="pct"></ac-stat>
<ac-send label="Usar este preço" text="Usar {preco:brl}."></ac-send>
<script>agentes.compute(s => ({ margem: (s.preco - 40) / s.preco * 100 }));</script>`;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});
const actorOf = (ctx: ToolContext) => ({
  type: "agent" as const,
  agentId: ctx.agentId,
  channelId: ctx.channelId,
  threadId: replyThreadOf(ctx),
  runId: ctx.runId,
});

export interface PollVote {
  userId: string;
  option: number;
}

/** A poll as the apps draw it; its question and options are the artifact's content (`poll.updated`). */
export interface PollView {
  id: string;
  closesAt: string;
  closedAt: string | null;
  /** How many people can answer: the conversation's members, or more when others voted. */
  people: number;
  votes: PollVote[];
}

async function memberCount(db: Database, channelId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), isNotNull(channelMembers.userId)));
  return row?.n ?? 0;
}

async function loadPollView(db: Database, orgId: string, artifactId: string, channelId: string): Promise<PollView> {
  const [poll] = await db
    .select()
    .from(polls)
    .where(and(eq(polls.artifactId, artifactId), eq(polls.orgId, orgId)));
  if (!poll) throw new NotFoundError("Poll not found");
  const votes = await db
    .select({ userId: pollVotes.userId, option: pollVotes.option })
    .from(pollVotes)
    .where(eq(pollVotes.artifactId, artifactId));
  const voters = new Set(votes.map((v) => v.userId)).size;
  return {
    id: artifactId,
    closesAt: poll.closesAt.toISOString(),
    closedAt: poll.closedAt?.toISOString() ?? null,
    people: Math.max(voters, await memberCount(db, channelId)),
    votes,
  };
}

/** A poll, for someone who can see its conversation. */
export async function getPoll(deps: ArtifactDeps, userId: string, orgId: string, artifactId: string) {
  const a = await getArtifact(deps, { type: "person", userId }, orgId, artifactId);
  if (a.kind !== "poll" || !a.channelId) throw new NotFoundError("Poll not found");
  return loadPollView(deps.db, orgId, artifactId, a.channelId);
}

/** A person's choices, replacing their last ones. Empty takes their vote back. The last one in closes the poll. */
export async function votePoll(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  options: number[],
): Promise<PollView> {
  const a = await getArtifact(deps, { type: "person", userId }, orgId, artifactId);
  if (a.kind !== "poll" || a.content.kind !== "poll" || !a.channelId) throw new NotFoundError("Poll not found");
  const { membership } = await requireChannelAccess(deps.db, userId, orgId, a.channelId);
  if (!can(membership, "post")) throw new ForbiddenError();
  const { options: labels, multiple } = a.content;
  const chosen = [...new Set(options)];
  if (chosen.some((o) => !Number.isInteger(o) || o < 0 || o >= labels.length)) {
    throw new ValidationError("no such option");
  }
  if (!multiple && chosen.length > 1) throw new ValidationError("this poll takes one option");
  await deps.db.transaction(async (tx) => {
    const [poll] = await tx
      .select()
      .from(polls)
      .where(and(eq(polls.artifactId, artifactId), eq(polls.orgId, orgId), isNull(polls.closedAt)))
      .for("update");
    if (!poll || poll.closesAt.getTime() <= Date.now()) {
      throw new ValidationError("This poll has closed", "poll.closed");
    }
    await tx.delete(pollVotes).where(and(eq(pollVotes.artifactId, artifactId), eq(pollVotes.userId, userId)));
    if (chosen.length > 0) {
      await tx.insert(pollVotes).values(chosen.map((option) => ({ orgId, artifactId, userId, option })));
    }
  });
  const poll = await loadPollView(deps.db, orgId, artifactId, a.channelId);
  await publishChannelEvent(deps.pubsub, { type: "poll.updated", channelId: a.channelId, poll });
  if (new Set(poll.votes.map((v) => v.userId)).size >= poll.people) {
    return (await closePoll(deps, orgId, artifactId)) ?? poll;
  }
  return poll;
}

/** How a closed poll came out, as the agent reads it. */
async function resultText(
  db: Database,
  content: { question: string; options: string[] },
  poll: PollView,
): Promise<string> {
  const ids = [...new Set(poll.votes.map((v) => v.userId))];
  const people = ids.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
    : [];
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "someone";
  const lines = content.options.map((label, i) => {
    const who = poll.votes.filter((v) => v.option === i).map((v) => nameOf(v.userId));
    return `- ${label}: ${who.length}${who.length ? ` (${who.join(", ")})` : ""}`;
  });
  return `"${content.question}"\n${lines.join("\n")}\n${ids.length} of ${poll.people} people answered.`;
}

/**
 * Closes a poll once: its time came (`POLL_CLOSE_JOB`) or the last person voted. The agent that started it hears the
 * result. Returns null when it had already closed or is gone.
 */
export async function closePoll(deps: ArtifactDeps, orgId: string, artifactId: string): Promise<PollView | null> {
  const [closed] = await deps.db
    .update(polls)
    .set({ closedAt: new Date() })
    .where(and(eq(polls.artifactId, artifactId), eq(polls.orgId, orgId), isNull(polls.closedAt)))
    .returning();
  if (!closed) return null;
  const [row] = await deps.db
    .select({ agentId: artifacts.createdById, channelId: artifacts.channelId })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.orgId, orgId), isNull(artifacts.deletedAt)));
  if (!row?.channelId) return null;
  const actor = { type: "agent" as const, agentId: row.agentId, channelId: row.channelId };
  const a = await getArtifact(deps, actor, orgId, artifactId);
  if (a.content.kind !== "poll" || !a.channelId) return null;
  const poll = await loadPollView(deps.db, orgId, artifactId, a.channelId);
  await publishChannelEvent(deps.pubsub, { type: "poll.updated", channelId: a.channelId, poll });
  const [run] = await deps.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, closed.runId)));
  if (!run) return poll;
  const notice: Notice = {
    kind: "poll_result",
    from: "Your poll",
    text: await resultText(deps.db, a.content, poll),
    refs: { artifactId, runId: run.id },
  };
  const delivered = await deps.db.transaction((tx) => deliverNoticeToRun(tx, run, notice));
  await publishDelivery(deps.pubsub, delivered).catch(() => {});
  return poll;
}

/**
 * What a person sent back from a block: their own message to the agent that made it, in the block's place. The apps
 * show this exact text beside the button, outside the block: the block proposes, the person sends.
 */
export async function replyToBlock(
  deps: ArtifactDeps & { pubsub: PubSub; judge?: Judge; talker?: Talker },
  userId: string,
  orgId: string,
  artifactId: string,
  input: { text: string; clientId?: string | null },
): Promise<MessageView> {
  const a = await getArtifact(deps, { type: "person", userId }, orgId, artifactId);
  if (a.kind !== "block" || !a.channelId) throw new NotFoundError("Block not found");
  const text = input.text.trim();
  if (!text) throw new ValidationError("Nothing to send");
  if (text.length > BLOCK_REPLY_CHARS) throw new ValidationError("That is too long to send");
  const [where] = await deps.db
    .select({ kind: channels.kind, handle: agents.handle })
    .from(channels)
    .leftJoin(agents, and(eq(agents.orgId, orgId), eq(agents.id, a.createdBy.id)))
    .where(and(eq(channels.id, a.channelId), eq(channels.orgId, orgId)));
  // Other agents may be in the channel: the answer goes to the one that asked.
  const body = where?.handle && where.kind !== "dm" ? `@${where.handle} ${text}` : text;
  return postPersonMessage(deps, userId, orgId, a.channelId, {
    body,
    threadId: a.threadId,
    clientId: input.clientId,
    meta: { blockReply: { id: a.id, title: a.title } },
  });
}

/**
 * `show_block` and `start_poll`: no scope, like `react` and `ask_user`, because they only speak in the agent's own
 * conversation and touch nothing outside it (ADR 0109). `tools/run-policy.ts` lists them as `HERE`.
 */
export function createBlockToolSource(deps: ArtifactDeps): ToolSource {
  const showBlock: ToolDefinition = {
    name: SHOW_BLOCK_TOOL,
    // The manual comes on first use (a call without html), not in every request (token-trim B2).
    description:
      "Show a live block in your reply: a small interactive thing the person uses now (a what-if simulator, options to see side by side, a filterable view, a short form); what they pick comes back to you. Use it on your own whenever using something beats reading about it; nobody needs to ask for one, and it needs no approval: it runs apart from the app and can't reach anything. Reports and documents are files; a question with plain choices is ask_user. Call it first with only `title` to get the manual (the parts, colors and script a block is built from), then with `html`. To change a block you showed, send its block_id.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200, description: "What it is, in the person's language" },
        subtitle: { type: "string", maxLength: 120, description: "A short line: where the data comes from and when" },
        html: { type: "string", description: "The block; without it, the manual to write one" },
        block_id: { type: "string", minLength: 36, maxLength: 36, description: "A block of yours to replace" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `Show ${str(input.title)}` }),
    async execute(input, ctx) {
      if (!str(input.html).trim()) return { content: BLOCK_MANUAL };
      try {
        const actor = actorOf(ctx);
        const html = str(input.html);
        const title = str(input.title);
        const subtitle = str(input.subtitle).trim() || undefined;
        const blockId = str(input.block_id);
        const a = blockId
          ? await updateArtifact(deps, actor, ctx.orgId, blockId, {
              content: { kind: "block", html, subtitle },
              note: "updated",
              title,
            })
          : await createConversationArtifact(deps, actor, ctx.orgId, {
              title,
              content: { kind: "block", html, subtitle },
            });
        return {
          content: `Showing "${a.title}" in your reply as block ${a.id}. Write a line or two around it, and don't repeat what it shows.`,
          data: { artifact: { id: a.id, version: a.version } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };

  const startPoll: ToolDefinition = {
    name: START_POLL_TOOL,
    description:
      "Start a vote among the people in this conversation: they mark options, everyone sees the votes come in, and the result reaches you when it closes (at closes_in_hours, or as soon as everyone has voted). Use it when a group has to decide; for one person's choice use ask_user or a block.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 200 },
        options: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, minItems: 2, maxItems: 8 },
        multiple: { type: "boolean", description: "Each person may mark more than one" },
        closes_in_hours: {
          type: "number",
          minimum: 1,
          maximum: MAX_POLL_HOURS,
          description: `Default ${DEFAULT_POLL_HOURS}`,
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `Start a vote: ${cutText(str(input.question), 60)}` }),
    async execute(input, ctx) {
      try {
        const hours = typeof input.closes_in_hours === "number" ? input.closes_in_hours : DEFAULT_POLL_HOURS;
        const closesAt = new Date(Date.now() + Math.min(MAX_POLL_HOURS, Math.max(1, hours)) * 3600_000);
        const question = str(input.question);
        const a = await createConversationArtifact(deps, actorOf(ctx), ctx.orgId, {
          title: question,
          content: {
            kind: "poll",
            question,
            options: (input.options as string[]) ?? [],
            multiple: input.multiple === true,
          },
        });
        await deps.db.transaction(async (tx) => {
          await tx.insert(polls).values({ artifactId: a.id, orgId: ctx.orgId, runId: ctx.runId, closesAt });
          await enqueue(tx, {
            orgId: ctx.orgId,
            kind: POLL_CLOSE_JOB,
            payload: { artifactId: a.id },
            dedupeKey: `${POLL_CLOSE_JOB}:${a.id}`,
            runAt: closesAt,
          });
        });
        return {
          content: `The vote is in your reply. It closes on ${closesAt.toISOString()} or when everyone has voted, and you'll hear the result then. Say in a line what you're asking and end your turn.`,
          data: { artifact: { id: a.id, version: a.version } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };

  return { name: "blocks", tools: async () => [showBlock, startPoll] };
}
