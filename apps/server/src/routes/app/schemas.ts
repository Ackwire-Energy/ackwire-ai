import { ACCOUNT_KINDS, BRAIN_EFFORTS } from "@agenteschat/adapters";
import { z } from "@hono/zod-openapi";

/** A last-message preview's `meta`: what the app needs to show a server-written body in the reader's language. */
export const PreviewMeta = z.record(z.string(), z.unknown()).nullable().openapi({
  description:
    "For a body the server wrote (`bodyCode` + `bodyParams`, a cut-off run's notes, memory lines): show it in the reader's language, like the message itself. Null for a plain message.",
});

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
    brain: z
      .object({
        kind: z.enum(["model", "claude_code", "codex"]),
        model: z
          .string()
          .nullable()
          .openapi({ description: "A computer brain's model label (Sonnet); null = the agent's model." }),
        computer: z.string().optional().openapi({ description: "Its computer's name (admins and the agent's owner)." }),
      })
      .optional()
      .openapi({ description: "Who thinks for it (ADR 0032), to show next to its name." }),
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
    unreadCount: z.number().int().optional().openapi({
      description:
        "Channel list only: messages since you last read it (since you joined, if never), not yours; a thread reply counts only in a thread you follow. At most 100; 0 when you're not a member.",
    }),
    lastMessage: z
      .object({
        id: z.uuid(),
        authorType: z.enum(["person", "agent"]),
        authorId: z.string().nullable(),
        authorName: z.string().nullable().openapi({ description: "Null when the author was deleted." }),
        preview: z.string().openapi({ description: "Plain text, at most 140 characters." }),
        meta: PreviewMeta,
        createdAt: z.string(),
      })
      .nullable()
      .optional()
      .openapi({
        description: "Channel list only: the latest top-level message; null when empty or you're not a member.",
      }),
  })
  .openapi("Channel");

const MessageUsage = z
  .object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number() })
  .openapi("MessageUsage", { description: "Agent messages: model and tokens of the run that wrote it (no money)." });

export const AgentAction = z
  .object({
    id: z.uuid(),
    kind: z
      .enum([
        "issue.created",
        "issue.updated",
        "issue.assigned",
        "memory.saved",
        "memory.updated",
        "memory.forgotten",
        "routine.created",
        "routine.updated",
        "channel.agent_added",
        "wiki.page_created",
        "wiki.page_edited",
        "thread.renamed",
        "thread.closed",
      ])
      .openapi({ description: "What the agent did; the app says it with `agentActions.{kind}` and `params`." }),
    agentId: z.uuid(),
    messageId: z.uuid().nullable(),
    requestedByUserId: z
      .string()
      .nullable()
      .openapi({ description: "The person the agent worked for: they, admins and the agent's owner may undo." }),
    target: z.object({
      type: z.enum(["issue", "memory", "routine", "channel", "wiki_page", "thread"]),
      id: z.string(),
      number: z.number().optional().openapi({ description: "Issues." }),
      title: z.string().optional().openapi({ description: "Issue, routine, page or thread title; channel name." }),
      slug: z.string().optional().openapi({ description: "Wiki pages." }),
    }),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]))
      .openapi({ description: "Values for the sentence (number, title, fields, status, text, agentName…)." }),
    createdAt: z.string(),
    undoableUntil: z
      .string()
      .openapi({ description: "Desfazer (or Refazer once undone) works until then; each undo/redo moves it." }),
    undoneAt: z.string().nullable().openapi({ description: "Set while undone." }),
    undoneByUserId: z.string().nullable(),
    redoneAt: z.string().nullable(),
  })
  .openapi("AgentAction", { description: "A change an agent made, shown as a receipt with Undo (ADR 0037)." });

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
          runId: z.uuid(),
          status: z.enum(["queued", "running", "waiting_approval", "waiting_input", "done", "failed", "canceled"]),
        }),
      ),
      blocked: z
        .array(z.uuid())
        .openapi({ description: "Agents it mentions that won't answer (they don't reply to this person)." }),
      referenced: z
        .array(z.uuid())
        .optional()
        .openapi({ description: "Agents it only references as part of the request to another agent: no run." }),
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
  pinned: z.boolean().optional().openapi({
    description:
      "In lists: true when pinned in its channel (absent: not pinned); live via `message.pinned`/`message.unpinned`.",
  }),
  actions: z.array(AgentAction).optional().openapi({
    description:
      "Agents' messages in lists: the changes made with this reply, as receipts with Undo; live via `message.actions`.",
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
      .enum(["no_computer", "exec_off", "runner_old", "tool_off", "not_installed", "outdated"])
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

export const BrainEffort = z.enum(BRAIN_EFFORTS).openapi("BrainEffort", {
  description: "How hard a computer brain thinks (Claude Code `--effort`; Codex maps `xhigh` and `max` to `high`).",
});

export const AccountKind = z.enum(ACCOUNT_KINDS).openapi("AccountKind");

export const MachineAccount = z
  .object({
    id: z.uuid(),
    kind: AccountKind,
    label: z.string(),
    email: z.string().nullable(),
    plan: z.string().nullable().openapi({ description: "`pro`, `max`, `team`, `plus`… as the CLI says." }),
    status: z.enum(["active", "signed_out"]),
    usedBy: z.array(z.string()).openapi({ description: "Names of the agents that think with it." }),
  })
  .openapi("MachineAccount", {
    description: "An account of a computer brain on a connected computer (ADR 0041). Metadata only, never a sign-in.",
  });

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
    machines: z
      .array(z.object({ machineId: z.uuid(), name: z.string(), online: z.boolean(), options: z.array(BrainOption) }))
      .openapi({
        description:
          "Every computer the caller may give the agent (admins: all; its owner: the ones they connected), with what each offers.",
      }),
    canEdit: z.boolean(),
    account: z
      .uuid()
      .nullable()
      .openapi({ description: "The account its computer brain runs with (ADR 0041); null = the computer's own." }),
    effort: BrainEffort.nullable().openapi({ description: "Null = the CLI's default." }),
    accounts: z.array(MachineAccount).openapi({ description: "The accounts on the agent's computer, both kinds." }),
    accountsOwner: z
      .object({ id: z.string(), name: z.string() })
      .nullable()
      .openapi({ description: "Who connected the agent's computer: only they add accounts or pick one." }),
    canManageAccounts: z.boolean(),
    accountsSupported: z.boolean().openapi({ description: "The computer's runner knows accounts (protocol 13)." }),
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
