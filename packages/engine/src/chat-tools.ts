import type { PubSub } from "@agenteschat/adapters";
import { and, count, eq, isNull, schema, sql } from "@agenteschat/db";
import { type ArtifactDeps, shareArtifact } from "./artifacts";
import { recordAudit } from "./audit";
import { addAgentReaction, isValidReaction, normalizeReaction } from "./context/feedback";
import { openPersonAgentDm } from "./dms";
import { publishMessageCreated } from "./events";
import { getMessage, insertMessage, MAX_MESSAGE_LENGTH, messageView, unreachedAgents, unreachedNote } from "./messages";
import { enqueue } from "./outbox";
import { actingRoutineOfCall, personBehindCall } from "./requester";
import { isRoutineRoomKey } from "./routine-brief";
import { personCanPost } from "./routine-state";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";
import { withWikiLinks } from "./wiki-links";

export const POST_MESSAGE_TOOL = "post_message";
export const SEND_DM_TOOL = "send_dm";
/** DMs one run may send: enough to tell a few people, never a mailing. */
const MAX_DMS_PER_RUN = 5;
export const REACT_TOOL = "react";
const MAX_FILES = 10;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** Posting where the run already is: a reply. */
const SAME_CONVERSATION = "That is this conversation: just reply.";

/** For matching what someone typed against names: lower case, no accents, no leading @. */
const plain = (v: string) =>
  v
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/^@/, "");

/**
 * Who in the organization `who` names: their @handle, email, full name, or a first name only one person
 * has. Several: the agent asks which one.
 */
export async function findMember(ctx: Pick<ToolContext, "db" | "orgId">, who: string) {
  const people = await ctx.db
    .select({
      userId: schema.organizationMembers.userId,
      handle: schema.organizationMembers.handle,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.organizationMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMembers.userId))
    .where(eq(schema.organizationMembers.orgId, ctx.orgId));
  const q = plain(who);
  if (!q) return [];
  const exact = people.filter(
    (p) => (p.handle && plain(p.handle) === q) || plain(p.email) === q || plain(p.name) === q,
  );
  if (exact.length > 0) return exact;
  return people.filter((p) => plain(p.name).split(/\s+/)[0] === q.split(/\s+/)[0] && !q.includes(" "));
}

/**
 * `post_message`: "manda no #geral" from a DM. Posts a new message (with
 * files) in another channel, on behalf of the person who asked: they must be
 * in that channel, and the agent too unless it is public. With nobody behind
 * the run, the agent posts as itself, only where it is a member. Files are brought
 * the way `share_artifact` does it (the same file when it's visible there, a
 * copy from a DM or a private channel the person is in). The post is an
 * agent message like any reply (same run and hop, so mentions follow the hop
 * limit). Audited.
 */
export function createChatToolSource(deps: { pubsub?: PubSub; artifacts: ArtifactDeps }): ToolSource {
  const tools: ToolDefinition[] = [
    {
      name: POST_MESSAGE_TOOL,
      description:
        'Post a new message in another channel, e.g. when someone in a DM says "manda no #geral". `channel` is its name (with or without #). Attach files with `artifact_ids` (from list_artifacts or files you made); a file from a DM goes as a copy. Only channels the person who asked is in (when nobody asked, channels you are in). Then reply here saying where you posted. For this conversation, just reply.',
      scope: "",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", minLength: 1, maxLength: 100 },
          text: { type: "string", maxLength: MAX_MESSAGE_LENGTH },
          artifact_ids: {
            type: "array",
            items: { type: "string", minLength: 36, maxLength: 36 },
            maxItems: MAX_FILES,
          },
        },
        required: ["channel"],
        additionalProperties: false,
      },
      describe: (input) => ({
        title: `Post in #${str(input.channel).replace(/^#/, "")}`,
        detail: str(input.text).slice(0, 500) || undefined,
      }),
      async execute(input, ctx) {
        try {
          const requester = await personBehindCall(ctx);
          // A routine set to act posts where its creator can post, as itself: never with their files.
          const routine = requester ? null : await actingRoutineOfCall(ctx);
          const creator = routine?.creatorUserId ?? null;
          const name = str(input.channel).trim().replace(/^#/, "").toLowerCase();
          const { channels, channelMembers } = schema;
          const [found] = await ctx.db
            .select({ id: channels.id, name: channels.name, visibility: channels.visibility, dmKey: channels.dmKey })
            .from(channels)
            .where(
              and(
                eq(channels.orgId, ctx.orgId),
                eq(channels.name, name),
                eq(channels.kind, "channel"),
                isNull(channels.archivedAt),
              ),
            );
          // A routine's room is never a place to post in (nor named to anyone).
          const channel = found && !isRoutineRoomKey(found.dmKey) ? found : undefined;
          const members = channel
            ? await ctx.db
                .select({ userId: channelMembers.userId, agentId: channelMembers.agentId })
                .from(channelMembers)
                .where(eq(channelMembers.channelId, channel.id))
            : [];
          // Not in it = not found: never reveal private channels. Nobody behind the run: the agent's own channels.
          if (
            !channel ||
            !(creator
              ? await personCanPost(ctx.db, ctx.orgId, creator, channel.id)
              : members.some((m) => (requester ? m.userId === requester : m.agentId === ctx.agentId)))
          ) {
            const who = creator ? "this routine's creator can post" : requester ? "the person who asked is" : "you are";
            return { content: `No channel #${name} that ${who} in.`, isError: true };
          }
          if (channel.id === ctx.channelId) return { content: SAME_CONVERSATION, isError: true };
          if (channel.visibility !== "public" && !members.some((m) => m.agentId === ctx.agentId)) {
            return {
              content: `You are not in #${channel.name} (private). Ask someone to add you to it, then try again.`,
              isError: true,
            };
          }
          const text = str(input.text).trim();
          const ids = [...new Set((Array.isArray(input.artifact_ids) ? input.artifact_ids : []).map(String))];
          if (!text && ids.length === 0) return { content: "Give a text or files to post.", isError: true };

          const actor = {
            type: "agent" as const,
            agentId: ctx.agentId,
            channelId: channel.id,
            threadId: null,
            runId: ctx.runId,
          };
          const files: string[] = [];
          for (const id of ids) {
            // A routine's own files live in its room, which only its run reads.
            const shared = await shareArtifact(deps.artifacts, actor, ctx.orgId, id, {
              requesterUserId: requester,
              // Only a routine's own run takes files from its room; a run it woke takes none from its conversation.
              alsoFrom: routine && ctx.background ? ctx.channelId : null,
            });
            files.push(shared.artifact.id);
          }
          const [run] = await ctx.db
            .select({ hop: schema.agentRuns.hop })
            .from(schema.agentRuns)
            .where(eq(schema.agentRuns.id, ctx.runId));
          // A mention reaches only that channel's members: the result names the agents it missed.
          const unreached = await unreachedAgents(ctx.db, {
            orgId: ctx.orgId,
            channelId: channel.id,
            authorAgentId: ctx.agentId,
            body: text,
          });
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            channelId: channel.id,
            threadId: null,
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: run?.hop ?? 0 },
            body: text,
            meta: {
              ...(files.length > 0 ? { artifacts: files } : {}),
              ...(unreached.length > 0 ? { unreachedAgents: unreached } : {}),
            },
          });
          await recordAudit(ctx.db, {
            orgId: ctx.orgId,
            actor: { type: "agent", id: ctx.agentId },
            action: "message.posted_elsewhere",
            target: { type: "message", id: message.id },
            details: {
              fromChannelId: ctx.channelId,
              toChannelId: channel.id,
              requesterUserId: requester,
              artifactIds: files,
              ...(routine ? { routineId: routine.routineId, creatorUserId: creator } : {}),
            },
          });
          if (deps.pubsub) {
            const [view] = await withWikiLinks(ctx.db, ctx.orgId, [messageView(message)]);
            if (view) await publishMessageCreated(deps.pubsub, view);
          }
          const note = unreachedNote(unreached, `#${channel.name}`, true);
          return {
            content: `Posted in #${channel.name}${files.length > 0 ? ` with ${files.length} file(s)` : ""}. Tell the person it's there.${note ? ` ${note}` : ""}`,
            data: { message: { id: message.id, channelId: channel.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: SEND_DM_TOOL,
      description:
        'Send a direct message to a person in the organization, e.g. "avisa a Thay na DM". `person` is their name, @handle or email. It goes in your DM with them (they get a notification); say in the text who asked and why, in their language. Only when someone asked you. If several people match, ask which one. Then reply here saying you sent it.',
      scope: "",
      inputSchema: {
        type: "object",
        properties: {
          person: { type: "string", minLength: 1, maxLength: 200 },
          text: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
        },
        required: ["person", "text"],
        additionalProperties: false,
      },
      describe: (input) => ({
        title: `Message ${str(input.person).replace(/^@/, "")}`,
        detail: str(input.text).slice(0, 500) || undefined,
      }),
      async execute(input, ctx) {
        try {
          const requester = await personBehindCall(ctx);
          // A routine set to act writes in its creator's DM with the agent, and no one else's.
          const routine = requester ? null : await actingRoutineOfCall(ctx);
          const creator = routine?.creatorUserId ?? null;
          if (!requester && !creator) return { content: "Only a person's request can send a DM.", isError: true };
          const text = str(input.text).trim();
          if (!text) return { content: "Give the text to send.", isError: true };
          const matches = await findMember(ctx, str(input.person));
          if (matches.length === 0) {
            return { content: `No one called "${str(input.person)}" in this organization.`, isError: true };
          }
          if (matches.length > 1) {
            const names = matches.map((m) => (m.handle ? `${m.name} (@${m.handle})` : m.name)).join(", ");
            return { content: `Several people match: ${names}. Ask which one.`, isError: true };
          }
          const to = matches[0] as (typeof matches)[number];
          if (creator && to.userId !== creator) {
            return {
              content:
                "A routine's background work sends a DM only to the person who set it up. Put what others should hear in hand_off.",
              isError: true,
            };
          }
          const { messages } = schema;
          const [sent] = await ctx.db
            .select({ n: count() })
            .from(messages)
            .where(
              and(eq(messages.orgId, ctx.orgId), eq(messages.agentRunId, ctx.runId), sql`${messages.meta} ? 'agentDm'`),
            );
          if ((sent?.n ?? 0) >= MAX_DMS_PER_RUN) {
            return { content: `You already sent ${MAX_DMS_PER_RUN} DMs in this turn.`, isError: true };
          }
          const dm = await openPersonAgentDm(ctx.db, ctx.orgId, to.userId, ctx.agentId);
          if (dm.id === ctx.channelId) return { content: SAME_CONVERSATION, isError: true };
          const [run] = await ctx.db
            .select({ hop: schema.agentRuns.hop })
            .from(schema.agentRuns)
            .where(eq(schema.agentRuns.id, ctx.runId));
          const unreached = await unreachedAgents(ctx.db, {
            orgId: ctx.orgId,
            channelId: dm.id,
            authorAgentId: ctx.agentId,
            body: text,
          });
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            channelId: dm.id,
            threadId: null,
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: run?.hop ?? 0 },
            body: text,
            // Started by the agent on someone's behalf: the person is notified (an agent's reply isn't).
            meta: {
              agentDm: { requesterUserId: requester, fromChannelId: ctx.channelId },
              ...(unreached.length > 0 ? { unreachedAgents: unreached } : {}),
            },
          });
          await enqueue(ctx.db, {
            orgId: ctx.orgId,
            kind: "notifications.message",
            payload: { messageId: message.id },
            dedupeKey: `notifications.message:${message.id}`,
            maxAttempts: 4,
          });
          await recordAudit(ctx.db, {
            orgId: ctx.orgId,
            actor: { type: "agent", id: ctx.agentId },
            action: "message.sent_dm",
            target: { type: "message", id: message.id },
            details: {
              toUserId: to.userId,
              fromChannelId: ctx.channelId,
              requesterUserId: requester,
              ...(routine ? { routineId: routine.routineId, creatorUserId: creator } : {}),
            },
          });
          if (deps.pubsub) {
            const [view] = await withWikiLinks(ctx.db, ctx.orgId, [messageView(message)]);
            if (view) await publishMessageCreated(deps.pubsub, view);
          }
          const note = unreachedNote(unreached, `your DM with ${to.name}`, false);
          return {
            content: `Sent to ${to.name} in your DM with them. Tell the person who asked.${note ? ` ${note}` : ""}`,
            data: { message: { id: message.id, channelId: dm.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "chat", tools: async () => tools };
}

/**
 * The built-in `react` tool: no scope needed (every agent may react, like
 * `ask_user`). Adds a reaction by the agent to the message that started the
 * run (or another message of this conversation) instead of replying to a
 * plain "thanks" / "ok". The executor ends such a run without posting text
 * (`data.reacted`). Never feedback: only people's 👍/👎 teach agents.
 */
export function createReactToolSource(deps: { pubsub?: PubSub }): ToolSource {
  const tool: ToolDefinition = {
    name: REACT_TOOL,
    description:
      'React with one emoji instead of replying, when the message only acknowledges or thanks ("valeu", "perfeito", "ok, pode seguir") and needs no answer. Reacts to the message you are answering unless you give `message_id` (a message of this conversation). After reacting, end your turn without any text: nothing else is posted. Never react and also reply.',
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        emoji: { type: "string", minLength: 1, maxLength: 16 },
        message_id: { type: "string", minLength: 36, maxLength: 36 },
      },
      required: ["emoji"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `React with ${str(input.emoji)}` }),
    async execute(input, ctx) {
      try {
        const reaction = normalizeReaction(str(input.emoji));
        if (!isValidReaction(reaction)) return { content: "Give exactly one emoji, e.g. 🙌.", isError: true };
        const messageId = str(input.message_id) || ctx.triggerMessageId;
        const target = await getMessage(ctx.db, ctx.orgId, messageId);
        if (!target || target.deletedAt || target.channelId !== ctx.channelId) {
          return { content: "No such message in this conversation.", isError: true };
        }
        await addAgentReaction(
          ctx.db,
          { orgId: ctx.orgId, agentId: ctx.agentId, messageId: target.id, reaction },
          deps.pubsub,
        );
        return {
          content: "Reaction added. End your turn now without any text.",
          data: { reacted: { messageId: target.id, reaction } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };
  return { name: "reactions", tools: async () => [tool] };
}
