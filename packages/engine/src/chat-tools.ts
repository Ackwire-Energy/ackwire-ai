import type { PubSub } from "@agenteschat/adapters";
import { and, eq, isNull, schema } from "@agenteschat/db";
import { type ArtifactDeps, shareArtifact } from "./artifacts";
import { recordAudit } from "./audit";
import { publishMessageCreated } from "./events";
import { insertMessage, MAX_MESSAGE_LENGTH, messageView } from "./messages";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";
import { withWikiLinks } from "./wiki-links";

export const POST_MESSAGE_TOOL = "post_message";
const MAX_FILES = 10;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** The person whose message started this run (null when an agent or a routine did). */
async function requesterOf(ctx: ToolContext): Promise<string | null> {
  const [m] = await ctx.db
    .select({ userId: schema.messages.authorUserId })
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, ctx.orgId), eq(schema.messages.id, ctx.triggerMessageId)));
  return m?.userId ?? null;
}

/**
 * `post_message`: "manda no #geral" from a DM. Posts a new message (with
 * files) in another channel, on behalf of the person who asked: they must be
 * in that channel, and the agent too unless it is public. Files are brought
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
        'Post a new message in another channel, e.g. when someone in a DM says "manda no #geral". `channel` is its name (with or without #). Attach files with `artifact_ids` (from list_artifacts or files you made); a file from a DM goes as a copy. Only channels the person who asked is in. Then reply here saying where you posted. For this conversation, just reply.',
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
          const requester = await requesterOf(ctx);
          if (!requester) return { content: "Only a person's request can post in another channel.", isError: true };
          const name = str(input.channel).trim().replace(/^#/, "").toLowerCase();
          const { channels, channelMembers } = schema;
          const [channel] = await ctx.db
            .select({ id: channels.id, name: channels.name, visibility: channels.visibility })
            .from(channels)
            .where(
              and(
                eq(channels.orgId, ctx.orgId),
                eq(channels.name, name),
                eq(channels.kind, "channel"),
                isNull(channels.archivedAt),
              ),
            );
          const members = channel
            ? await ctx.db
                .select({ userId: channelMembers.userId, agentId: channelMembers.agentId })
                .from(channelMembers)
                .where(eq(channelMembers.channelId, channel.id))
            : [];
          // Not in it = not found: never reveal private channels.
          if (!channel || !members.some((m) => m.userId === requester)) {
            return { content: `No channel #${name} that the person who asked is in.`, isError: true };
          }
          if (channel.id === ctx.channelId) return { content: "That is this conversation: just reply.", isError: true };
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
            const shared = await shareArtifact(deps.artifacts, actor, ctx.orgId, id, { requesterUserId: requester });
            files.push(shared.artifact.id);
          }
          const [run] = await ctx.db
            .select({ hop: schema.agentRuns.hop })
            .from(schema.agentRuns)
            .where(eq(schema.agentRuns.id, ctx.runId));
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            channelId: channel.id,
            threadId: null,
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: run?.hop ?? 0 },
            body: text,
            meta: files.length > 0 ? { artifacts: files } : undefined,
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
            },
          });
          if (deps.pubsub) {
            const [view] = await withWikiLinks(ctx.db, ctx.orgId, [messageView(message)]);
            if (view) await publishMessageCreated(deps.pubsub, view);
          }
          return {
            content: `Posted in #${channel.name}${files.length > 0 ? ` with ${files.length} file(s)` : ""}. Tell the person it's there.`,
            data: { message: { id: message.id, channelId: channel.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "chat", tools: async () => tools };
}
