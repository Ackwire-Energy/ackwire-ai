import { z } from "@hono/zod-openapi";

export const Role = z.enum(["owner", "admin", "member"]).openapi("Role");

export const Organization = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: Role,
    context: z.string().optional(),
    logo: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "The workspace logo (`/api/app/org-logos/…`); null = the agent mark." }),
  })
  .openapi("Organization");

export const Member = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    avatarUrl: z.string().nullable().openapi({ description: "The photo uploaded here; wins over `image`." }),
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

/** Who can talk to an agent (D31). `userIds` only for `people`; the owner always can. */
export const AgentAudience = z
  .object({ mode: z.enum(["everyone", "people", "owner"]), userIds: z.array(z.string()).max(500) })
  .openapi("AgentAudience");

export const AgentAppearance = z
  .object({
    color: z.enum(["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"]),
    eyes: z.enum(["round", "dots", "wide", "happy", "sleepy"]),
    accessory: z.enum([
      "none",
      "hat",
      "cap",
      "headphones",
      "bow",
      "crown",
      "antenna",
      "headset",
      "beanie",
      "party",
      "flower",
      "scarf",
    ]),
  })
  .openapi("AgentAppearance");

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
    monthlyBudgetUsd: z
      .number()
      .nullable()
      .optional()
      .openapi({ description: "Admins only: its own monthly budget; null = the workspace default." }),
    budgetUsedPercent: z
      .number()
      .optional()
      .openapi({ description: "This month's spend over its budget, in % (in the agent list)." }),
    createdAt: z.string(),
    audience: AgentAudience,
    audienceMode: z.enum(["everyone", "people", "owner"]),
    canTalk: z.boolean().openapi({ description: "Whether the current person can talk to it (mentions, DMs)." }),
    appearance: AgentAppearance.nullable().openapi({ description: "Its look; null = the default." }),
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
  .object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number() })
  .openapi("MessageUsage", { description: "Agent messages: model and tokens of the run that wrote it (no money)." });

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
          status: z.enum(["queued", "running", "waiting_approval", "waiting_input", "done", "failed", "canceled"]),
        }),
      ),
    })
    .optional()
    .openapi({ description: "People's messages: agents that saw it, picked it up, and how their runs ended." }),
  meta: z
    .record(z.string(), z.unknown())
    .openapi({ description: "Attachments, e.g. `{ approvalId }` on an approval card (see /approvals)." }),
  usage: MessageUsage.optional(),
  reactions: z
    .array(
      z.object({
        reaction: z.string(),
        count: z.number(),
        userIds: z.array(z.string()),
        agentIds: z.array(z.string()),
      }),
    )
    .optional()
    .openapi({
      description:
        "In lists: reactions (`+1`/`-1` or an emoji) and who reacted (people in `userIds`, agents in `agentIds`); live via `message.reactions`.",
    }),
  memories: z
    .array(
      z.object({
        id: z.uuid(),
        agentId: z.uuid(),
        kind: z.enum(["fact", "preference", "decision", "note", "lesson"]),
        text: z.string(),
        createdAt: z.string(),
      }),
    )
    .optional()
    .openapi({
      description:
        "People's messages: what agents saved to memory from them (the memory mark); live via `message.memories`.",
    }),
  createdAt: z.string(),
});

export const Message = MessageBase.extend({
  notices: z
    .array(
      z.object({
        agentId: z.uuid(),
        text: z.string(),
        code: z
          .string()
          .optional()
          .openapi({ description: "`audience.only` / `audience.nobody`: translate with `params`." }),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional()
    .openapi({
      description:
        "Only in the sender's POST response: agents addressed that won't answer this person (who can talk to the agent), with the text to show them.",
    }),
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

/** ADR 0032: who thinks for an agent. */
export const BrainKind = z.enum(["model", "claude_code", "codex"]).openapi("BrainKind");

export const BrainOption = z
  .object({
    kind: BrainKind,
    available: z.boolean(),
    reason: z
      .enum(["no_computer", "exec_off", "runner_old", "not_installed", "outdated"])
      .optional()
      .openapi({ description: "Why it can't be chosen now (computer brains)." }),
    experimental: z.boolean().openapi({ description: 'Still being tested ("Em teste"): Codex.' }),
    models: z.array(
      z.object({
        value: z.string().openapi({ description: "What is stored and passed to the CLI (`opus`, `gpt-…`)." }),
        label: z.string(),
        modelId: z.string().optional().openapi({ description: "The model id behind an alias." }),
        recommended: z.boolean().optional(),
      }),
    ),
    defaultModel: z.string().nullable(),
  })
  .openapi("BrainOption");

export const AgentBrain = z
  .object({
    agentId: z.uuid(),
    brain: BrainKind,
    model: z.string().nullable().openapi({ description: "As stored; null = the brain's default." }),
    effectiveModel: z.string().nullable(),
    fallback: z
      .boolean()
      .openapi({ description: "When the computer can't answer, answer through the API (agent's budget)." }),
    computer: z.object({ machineId: z.uuid(), name: z.string(), online: z.boolean() }).nullable(),
    options: z.array(BrainOption),
    canEdit: z.boolean(),
  })
  .openapi("AgentBrain");

export const MissionBrain = z
  .object({
    missionId: z.uuid(),
    brain: BrainKind.nullable().openapi({ description: "The override; null = from the executor." }),
    model: z.string().nullable(),
    effectiveBrain: BrainKind,
    effectiveModel: z.string().nullable(),
    options: z.array(BrainOption),
    canSetBrain: z.boolean().openapi({ description: "Before Start, the owner or someone who decides." }),
    canSetModel: z.boolean().openapi({ description: "While open, the owner or someone who decides." }),
  })
  .openapi("MissionBrain");
