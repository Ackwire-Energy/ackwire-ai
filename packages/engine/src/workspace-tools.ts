import type { PubSub } from "@agenteschat/adapters";
import { and, eq, isNull, schema, sql } from "@agenteschat/db";
import { type ActionRecord, actWithUndo } from "./agent-actions";
import { addChannelMember } from "./channels";
import { getChannelCached } from "./context";
import { closeThread, getThread, updateThread } from "./threads";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

export const ADD_TO_CHANNEL_TOOL = "add_agent_to_channel";
export const UPDATE_THREAD_TOOL = "update_thread";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** The person whose message started this run (null when an agent or a routine did). */
async function requesterOf(ctx: ToolContext): Promise<string | null> {
  const [m] = await ctx.db
    .select({ type: schema.messages.authorType, userId: schema.messages.authorUserId })
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, ctx.orgId), eq(schema.messages.id, ctx.triggerMessageId)));
  return m?.type === "person" ? (m.userId ?? null) : null;
}

const noRequester: ToolOutput = {
  content: "Only a person's request can change this; nothing was changed.",
  isError: true,
};

/**
 * Organizing the workspace for the person who asked (ADR 0037 round 2), with
 * their rights: `add_agent_to_channel` and `update_thread` (rename, close).
 * Internal and reversible, so no approval: each change is a receipt with
 * Undo on the reply.
 */
export function createWorkspaceToolSource(deps: { pubsub?: PubSub }): ToolSource {
  const tools: ToolDefinition[] = [
    {
      name: ADD_TO_CHANNEL_TOOL,
      description:
        "Add an agent (by handle, e.g. @lia) to a channel (by name; default: this one) when the person asks or the work needs it there. Works with the rights of the person who asked (the channel's creator or an admin, and the agent's owner or an admin). No permission needed: the person sees it with Undo.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", minLength: 1, maxLength: 100 },
          channel: { type: "string", maxLength: 100, description: "Channel name, with or without #" },
          auto_reply: {
            type: "boolean",
            description: "It may answer there without being mentioned (default true)",
          },
        },
        required: ["agent"],
        additionalProperties: false,
      },
      describe: (input) => ({ title: `Add ${str(input.agent)} to #${str(input.channel).replace(/^#/, "") || "here"}` }),
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const handle = str(input.agent).trim().replace(/^@/, "").toLowerCase();
          const [agent] = await ctx.db
            .select({ id: schema.agents.id, name: schema.agents.name, handle: schema.agents.handle })
            .from(schema.agents)
            .where(
              and(
                eq(schema.agents.orgId, ctx.orgId),
                isNull(schema.agents.archivedAt),
                sql`lower(${schema.agents.handle}) = ${handle}`,
              ),
            );
          if (!agent) return { content: `No agent @${handle} in this organization.`, isError: true };
          const name = str(input.channel).trim().replace(/^#/, "").toLowerCase();
          const { channels, channelMembers } = schema;
          const [channel] = name
            ? await ctx.db
                .select({ id: channels.id, name: channels.name, kind: channels.kind })
                .from(channels)
                .where(
                  and(
                    eq(channels.orgId, ctx.orgId),
                    eq(channels.name, name),
                    eq(channels.kind, "channel"),
                    isNull(channels.archivedAt),
                  ),
                )
            : [await getChannelCached(ctx.db, ctx.orgId, ctx.channelId)];
          if (channel?.kind !== "channel") {
            return {
              content: name ? `No channel #${name}.` : "Agents join channels, not this conversation.",
              isError: true,
            };
          }
          const [present] = await ctx.db
            .select({ id: channelMembers.id })
            .from(channelMembers)
            .where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.agentId, agent.id)));
          if (present) return { content: `@${agent.handle} is already in #${channel.name}.` };
          const autoReply = input.auto_reply !== false;
          await actWithUndo(
            ctx,
            (db) => addChannelMember(db, requester, ctx.orgId, channel.id, { agentId: agent.id, autoReply }, deps),
            () => ({
              kind: "channel.agent_added",
              target: { type: "channel", id: channel.id, title: channel.name },
              params: { agentId: agent.id, agentName: agent.name, agentHandle: agent.handle, channel: channel.name },
              before: null,
              after: { agentId: agent.id, autoReply },
            }),
          );
          return { content: `Added @${agent.handle} to #${channel.name}.` };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: UPDATE_THREAD_TOOL,
      description:
        "Rename this thread (`title`) or close it (`close: true`, when its work is done) for the person who asked, with their rights. No permission needed: the person sees it with Undo.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          close: { type: "boolean" },
        },
        additionalProperties: false,
      },
      describe: (input) => ({ title: input.close ? "Close this thread" : `Rename this thread to ${str(input.title)}` }),
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const title = str(input.title).trim();
          if (!title && input.close !== true) return { content: "Give a new `title` or `close: true`.", isError: true };
          const channel = await getChannelCached(ctx.db, ctx.orgId, ctx.channelId);
          if (channel?.kind === "dm" && ctx.threadRootId === ctx.triggerMessageId) {
            return { content: "This conversation is not a thread.", isError: true };
          }
          const rootId = ctx.threadRootId;
          const done: string[] = [];
          await actWithUndo(
            ctx,
            async (db) => {
              const threadDeps = { db, pubsub: deps.pubsub };
              const before = await getThread(db, requester, ctx.orgId, rootId);
              const records: ActionRecord[] = [];
              if (title && title !== before.title) {
                const after = await updateThread(threadDeps, requester, ctx.orgId, rootId, { title });
                records.push({
                  kind: "thread.renamed",
                  target: { type: "thread", id: rootId, title: after.title ?? title },
                  params: { from: before.title ?? before.rootText, to: after.title ?? title },
                  before: { title: before.title },
                  after: { title: after.title },
                });
                done.push(`renamed to "${after.title ?? title}"`);
              }
              if (input.close === true && before.state === "open") {
                const after = await closeThread(threadDeps, requester, ctx.orgId, rootId);
                records.push({
                  kind: "thread.closed",
                  target: { type: "thread", id: rootId, title: after.title ?? after.rootText },
                  params: { title: after.title ?? after.rootText },
                  before: { state: before.state },
                  after: { state: "closed" },
                });
                done.push("closed");
              }
              return records;
            },
            (records) => records,
          );
          return { content: done.length ? `Thread ${done.join(" and ")}.` : "Nothing to change." };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "workspace", tools: async () => tools };
}
