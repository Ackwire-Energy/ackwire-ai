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
  })
  .openapi("Member");

export const Invitation = z
  .object({ id: z.uuid(), email: z.string(), role: Role, expiresAt: z.string() })
  .openapi("Invitation");

export const Credential = z
  .object({
    id: z.uuid(),
    provider: z.enum(["anthropic"]),
    label: z.string(),
    keyHint: z.string().openapi({ description: "Last 4 characters of the key. The key itself is never returned." }),
    workspaceIdHint: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "Last characters of the workspace the key is scoped to, if set." }),
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
    createdAt: z.string(),
  })
  .openapi("Channel");

export const Message = z
  .object({
    id: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    author: z.object({ type: z.enum(["person", "agent"]), id: z.string().nullable() }),
    body: z.string(),
    mentionedAgentIds: z.array(z.uuid()),
    agentRunId: z.uuid().nullable(),
    meta: z
      .record(z.string(), z.unknown())
      .openapi({ description: "Attachments, e.g. `{ approvalId }` on an approval card (see /approvals)." }),
    createdAt: z.string(),
  })
  .openapi("Message");

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
