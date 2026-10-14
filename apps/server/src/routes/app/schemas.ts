import { z } from "@hono/zod-openapi";

export const Role = z.enum(["owner", "admin", "member"]).openapi("Role");

export const Organization = z
  .object({ id: z.uuid(), name: z.string(), role: Role, context: z.string().optional() })
  .openapi("Organization");

export const Member = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: Role,
    joinedAt: z.string(),
    handle: z.string(),
    timezone: z.string(),
  })
  .openapi("Member");

export const Invitation = z
  .object({ id: z.uuid(), email: z.string(), role: Role, expiresAt: z.string() })
  .openapi("Invitation");

export const Credential = z
  .object({
    id: z.uuid(),
    provider: z.enum(["anthropic", "openai"]),
    label: z.string(),
    keyHint: z.string().openapi({ description: "Last 4 characters of the key. The key itself is never returned." }),
    workspaceIdHint: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "Last characters of the workspace the key is scoped to, if set." }),
    isDefault: z
      .boolean()
      .optional()
      .openapi({ description: "The workspace's default key (agents without their own key, router, summaries)." }),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .openapi("Credential");

export const Agent = z
  .object({
    id: z.uuid(),
    name: z.string(),
    handle: z.string(),
    role: z.string(),
    instructions: z.string(),
    model: z.string(),
    ownerUserId: z.string().nullable(),
    hasCredential: z.boolean(),
    monthlyBudgetUsd: z.number().nullable(),
    createdAt: z.string(),
  })
  .openapi("Agent");

export const Channel = z
  .object({
    id: z.uuid(),
    name: z.string(),
    topic: z.string(),
    visibility: z.enum(["public", "private"]),
    isMember: z.boolean(),
    createdByUserId: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "The channel's creator: may manage its members, like admins." }),
    createdAt: z.string(),
  })
  .openapi("Channel");

const MessageUsage = z
  .object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() })
  .openapi("MessageUsage", { description: "Agent messages: model, tokens and cost of the run that wrote it." });

const MessageBase = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  threadId: z.uuid().nullable(),
  author: z.object({ type: z.enum(["person", "agent"]), id: z.string().nullable() }),
  body: z.string(),
  mentionedAgentIds: z.array(z.uuid()),
  mentionedUserIds: z.array(z.string()).openapi({ description: "People mentioned by handle who are in the channel." }),
  agentRunId: z.uuid().nullable(),
  clientId: z.string().nullable().openapi({ description: "Echo of the sender's `clientId`." }),
  receipts: z
    .object({
      seenBy: z.array(z.uuid()),
      pickedBy: z.array(z.uuid()),
      handled: z.array(
        z.object({
          agentId: z.uuid(),
          status: z.enum(["queued", "running", "waiting_approval", "waiting_input", "done", "failed"]),
        }),
      ),
    })
    .optional()
    .openapi({ description: "People's messages: agents that saw it, picked it up, and how their runs ended." }),
  meta: z
    .record(z.string(), z.unknown())
    .openapi({ description: "Attachments, e.g. `{ approvalId }` on an approval card (see /approvals)." }),
  usage: MessageUsage.optional(),
  createdAt: z.string(),
});

export const Message = MessageBase.extend({
  replies: z
    .object({ count: z.number(), lastAt: z.string().nullable(), latest: z.array(MessageBase) })
    .optional()
    .openapi({ description: "With `include=replies`: the thread's size, last activity and last three replies." }),
}).openapi("Message");

export const Usage = z
  .object({
    agentId: z.uuid(),
    handle: z.string(),
    calls: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
  })
  .openapi("AgentUsage");

export const Model = z
  .object({
    id: z.string(),
    label: z.string(),
    provider: z.string(),
    inputUsdPerMTok: z.number(),
    outputUsdPerMTok: z.number(),
  })
  .openapi("Model");
