import type { GifProvider, PubSub } from "@agenteschat/adapters";
import { and, desc, eq, gt, isNull, or, schema, sql } from "@agenteschat/db";
import { channelSkip, MEDIA_GIF_PICK_FROM, MEDIA_GIF_SEARCH_LIMIT, pickGifIndex, withTimeout } from "./agent-media";
import { getAgentCached } from "./agents";
import { getChannelCached } from "./context";
import { publishMessageCreated } from "./events";
import {
  type GifMedia,
  type GifRating,
  isStickerMood,
  MEDIA_IN_RUN_KEY,
  type MessageMedia,
  mediaSettings,
  runMediaCount,
  SEND_GIF_TOOL,
  SEND_STICKER_TOOL,
  STICKER_MOODS,
  type StickerMood,
} from "./media";
import { insertMessage, messageView } from "./messages";
import { replyThreadOf } from "./runs";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

/**
 * The agent's own GIF and sticker tools (ADR 0091, addendum 2026-10-31): `send_gif` and `send_sticker`, for when
 * someone asks for one or a light moment clearly invites it. Built in like `react` (no scope: the conversation's
 * group, always listed), and listed only where they can send: the sticker with the workspace's stickers on, the GIF
 * with the server's GIF search and the workspace's GIFs on, both with the agent's own switch (`agents.media_replies`)
 * and in a chat channel or a DM with a person. The workspace's level (`agent_media`) is only the post-reply step's
 * (`agent-media.ts`), never these tools'.
 *
 * What they post is part of the agent's answer: a message of the run, in its conversation, with no text. Like any
 * GIF or sticker alone it routes to nobody and starts no run (`insertMessageWithRuns`); unlike the post-reply step's
 * it isn't silent: whoever is behind the run hears of it and it counts as unread. An empty final reply after it posts
 * nothing (`data.mediaSent`, read by the executor like `react`).
 */

/** GIFs and stickers one run may send: past it, the tools say stop. */
export const MEDIA_PER_RUN_MAX = 3;
/** A search is a few English words: past these, the rest is dropped. */
const SEARCH_WORDS_MAX = 6;
const SEARCH_CHARS_MAX = 50;
/** How long a call waits for the GIF search, and for each lookup after it. */
const SEARCH_TIMEOUT_MS = 6_000;
/** A GIF among the conversation's last this many messages isn't picked again while the search has others. */
const RECENT_GIF_MESSAGES = 30;
/** The messages table is partitioned by time (ADR 0009): conversation reads stay within the last week. */
const WEEK_MS = 7 * 24 * 3600_000;

/** When to send one, as both descriptions say it. */
const WHEN =
  "when someone asks for one, or when the moment clearly invites a playful touch in a light conversation (a greeting, a celebration, thanks). Never in serious work (a problem, an error, a decision to make, a report). Usually one per turn, a GIF or a sticker and not both; more only when asked.";
/** What happens, and what to write after it. */
const AFTER =
  "It is posted at once, as a message of its own: after it, write text only if there is something to add; otherwise end your turn with an empty reply.";
/** The tool's answer once it is posted: its first line is what other runs read of it. */
const SENT_NOTE = "If you have nothing to add, end your turn with an empty reply.";
const TOO_MANY = `You already sent ${MEDIA_PER_RUN_MAX} GIFs or stickers in this turn: stop and finish your reply.`;
const NO_RUN = "Only an answer in a conversation sends a GIF or a sticker.";
const NO_SEARCH = 'Say what the GIF shows in a few English words, e.g. "good morning".';

/** What each sticker shows, for the model picking one. */
const MOODS: Record<StickerMood, string> = {
  celebrate: "a win, a launch, good news",
  love: "thanks, warmth, a friendly hello or goodbye",
  deal: "agreed, done, on it",
  thinking: "pondering, give me a moment",
  wow: "amazed, impressed",
  dizzy: "confused or overwhelmed, in fun",
};
/** The moods as the model reads them: "celebrate (a win, a launch, good news), love (…)". */
const MOOD_HELP = Object.entries(MOODS)
  .map(([mood, shows]) => `${mood} (${shows})`)
  .join(", ");

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** The search as the provider gets it: one line, at most six words and 50 characters. */
export function gifSearchOf(v: unknown): string {
  const words = str(v).trim().split(/\s+/).slice(0, SEARCH_WORDS_MAX);
  return words.join(" ").slice(0, SEARCH_CHARS_MAX).trim();
}

export interface MediaToolDeps {
  pubsub?: PubSub;
  /** The server's GIF search (`Adapters.gifs`); null: no `send_gif`, the agents' stickers only. */
  gifs: GifProvider | null;
}

type RunRow = { hop: number; createdAt: Date };

/** The run's hop (its messages carry it) and start (its own messages are read from there). */
async function runOf(ctx: ToolContext): Promise<RunRow | null> {
  const [run] = await ctx.db
    .select({ hop: schema.agentRuns.hop, createdAt: schema.agentRuns.createdAt })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.orgId, ctx.orgId), eq(schema.agentRuns.id, ctx.runId)));
  return run ?? null;
}

/** The run's own GIFs and stickers so far (`runMediaCount`). */
const sentBy = (ctx: ToolContext, run: RunRow) => ({
  orgId: ctx.orgId,
  id: ctx.runId,
  channelId: ctx.channelId,
  createdAt: run.createdAt,
});

/**
 * Posts `media` as the run's own message where it answers, unless the run already sent `MEDIA_PER_RUN_MAX` (counted
 * again under a lock, so calls made at once can't all pass), and publishes it like any message of the agent. Null at
 * the cap.
 */
async function postMedia(deps: MediaToolDeps, ctx: ToolContext, run: RunRow, media: MessageMedia) {
  const message = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`run-media:${ctx.runId}`}))`);
    if ((await runMediaCount(tx, sentBy(ctx, run))) >= MEDIA_PER_RUN_MAX) return null;
    return insertMessage(tx, {
      orgId: ctx.orgId,
      channelId: ctx.channelId,
      // Where the run's replies go: its thread, or the main timeline it was asked in.
      threadId: replyThreadOf(ctx),
      // The same agent, run and hop as the run's replies: part of its answer.
      author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: run.hop },
      body: "",
      meta: { media, [MEDIA_IN_RUN_KEY]: true },
    });
  });
  if (message && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message;
}

/** GIF ids among the conversation's latest messages (anyone's), so a second GIF isn't the first again. */
async function recentGifIds(ctx: ToolContext): Promise<Set<string>> {
  const { messages } = schema;
  const threadId = replyThreadOf(ctx);
  const rows = await ctx.db
    .select({ id: sql<string | null>`${messages.meta}->'media'->>'id'` })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, ctx.orgId),
        eq(messages.channelId, ctx.channelId),
        threadId ? or(eq(messages.threadId, threadId), eq(messages.id, threadId)) : isNull(messages.threadId),
        isNull(messages.deletedAt),
        gt(messages.createdAt, new Date(Date.now() - WEEK_MS)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(RECENT_GIF_MESSAGES);
  return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
}

/**
 * A GIF for `query` at `rating`: one of the first results (`MEDIA_GIF_PICK_FROM`), past the ones in `recent` while
 * others are left, fixed by `seed`, then looked up again (`get`: the provider checks the rating) and kept as the
 * provider says it, never with a URL. A result the provider no longer has gives way to the next. Null: none.
 * Throws when the search fails or takes too long.
 */
export async function findGif(
  gifs: GifProvider,
  input: { query: string; rating: GifRating; seed: string; recent?: ReadonlySet<string> },
): Promise<GifMedia | null> {
  const page = await withTimeout(
    gifs.search({ query: input.query, rating: input.rating, lang: "en", limit: MEDIA_GIF_SEARCH_LIMIT, offset: 0 }),
    SEARCH_TIMEOUT_MS,
    "the GIF search",
  );
  const found = page.gifs.filter((g) => typeof g.id === "string" && g.id !== "");
  const fresh = found.filter((g) => !input.recent?.has(g.id));
  const pool = (fresh.length > 0 ? fresh : found).slice(0, MEDIA_GIF_PICK_FROM);
  const start = pickGifIndex(input.seed, pool.length);
  for (const candidate of [...pool.slice(start), ...pool.slice(0, start)]) {
    const gif = await withTimeout(gifs.get(candidate.id, input.rating), SEARCH_TIMEOUT_MS, "the GIF lookup");
    if (!gif) continue;
    return {
      kind: "gif",
      provider: "giphy",
      id: gif.id,
      title: gif.title,
      width: Math.max(1, Math.round(gif.width) || 1),
      height: Math.max(1, Math.round(gif.height) || 1),
    };
  }
  return null;
}

/** `send_gif`. `sticker`: `send_sticker` is listed too (a failed search points to it). */
function gifTool(deps: MediaToolDeps, gifs: GifProvider, options: { sticker: boolean }): ToolDefinition {
  const instead = options.sticker ? " Send your sticker with `send_sticker` instead, or just reply." : " Just reply.";
  return {
    name: SEND_GIF_TOOL,
    description: `Send a GIF in this conversation ${WHEN} \`search\` says what the GIF shows, as a short search in English (1 to 6 words, e.g. "good morning coffee cat") whatever language the conversation is in: GIF search matches English best. ${AFTER}`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: 'What the GIF shows, in English, 1 to 6 words (e.g. "good morning coffee cat").',
        },
      },
      required: ["search"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: "Send a GIF", detail: gifSearchOf(input.search) || undefined }),
    async execute(input, ctx) {
      try {
        const query = gifSearchOf(input.search);
        if (!query) return { content: NO_SEARCH, isError: true };
        const run = await runOf(ctx);
        if (!run) return { content: NO_RUN, isError: true };
        // Before the search: past the cap, nothing is asked of the provider.
        const sent = await runMediaCount(ctx.db, sentBy(ctx, run));
        if (sent >= MEDIA_PER_RUN_MAX) return { content: TOO_MANY, isError: true };
        const [{ gifRating }, recent] = await Promise.all([mediaSettings(ctx.db, ctx.orgId), recentGifIds(ctx)]);
        const seed = `${ctx.runId}:${query}`;
        // Undefined: the provider didn't answer (an outage, a limit, too slow), the same as no GIFs for now.
        const gif = await findGif(gifs, { query, rating: gifRating, seed, recent }).catch(() => undefined);
        if (gif === undefined) return { content: `GIF search isn't answering right now.${instead}`, isError: true };
        if (!gif) {
          return { content: `No GIF found for "${query}". Try other words in English.${instead}`, isError: true };
        }
        const message = await postMedia(deps, ctx, run, gif);
        if (!message) return { content: TOO_MANY, isError: true };
        // Never the GIF's title: the provider's words are outside text (ADR 0091 §6).
        return {
          content: `GIF sent.\n${SENT_NOTE}`,
          data: { mediaSent: { messageId: message.id, kind: "gif" } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };
}

/** `send_sticker`: the calling agent's own sticker, in one of its moods. */
function stickerTool(deps: MediaToolDeps): ToolDefinition {
  return {
    name: SEND_STICKER_TOOL,
    description: `Send one of your own animated stickers in this conversation (you, in a mood) ${WHEN} If someone asks for a GIF and you have no \`send_gif\` tool, GIFs are off here: send your sticker instead, and never say you can't send GIFs. ${AFTER}`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        mood: { type: "string", enum: [...STICKER_MOODS], description: `Which sticker: ${MOOD_HELP}.` },
      },
      required: ["mood"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `Send a sticker (${str(input.mood)})` }),
    async execute(input, ctx) {
      try {
        const mood = input.mood;
        if (!isStickerMood(mood)) return { content: `Pick a mood: ${STICKER_MOODS.join(", ")}.`, isError: true };
        const run = await runOf(ctx);
        if (!run) return { content: NO_RUN, isError: true };
        const message = await postMedia(deps, ctx, run, { kind: "sticker", agentId: ctx.agentId, mood });
        if (!message) return { content: TOO_MANY, isError: true };
        return {
          content: `Sticker sent.\n${SENT_NOTE}`,
          data: { mediaSent: { messageId: message.id, kind: "sticker" } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };
}

/**
 * `send_gif` and `send_sticker` for a run (see the file's comment). Read on every listing and call, so a switch
 * turned off takes them away: the workspace's switches and the agent's go through the per-process caches.
 */
export function createMediaToolSource(deps: MediaToolDeps): ToolSource {
  return {
    name: "media",
    async tools(ctx) {
      // A mission task's call through the bridge has no run: no conversation to answer in.
      if (!ctx.runId) return [];
      const [settings, agent, channel] = await Promise.all([
        mediaSettings(ctx.db, ctx.orgId),
        getAgentCached(ctx.db, ctx.orgId, ctx.agentId),
        getChannelCached(ctx.db, ctx.orgId, ctx.channelId),
      ]);
      // The agent's own switch, and a place people read: a chat channel or a DM with a person.
      if (!agent || agent.archivedAt || !agent.mediaReplies || channelSkip(channel)) return [];
      const sticker = settings.agentStickers;
      const gifs = deps.gifs?.available() && settings.gifs ? deps.gifs : null;
      return [...(gifs ? [gifTool(deps, gifs, { sticker })] : []), ...(sticker ? [stickerTool(deps)] : [])];
    },
  };
}
