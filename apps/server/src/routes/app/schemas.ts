import { ACCOUNT_KINDS, BRAIN_EFFORTS } from "@agenteschat/adapters";
import { AGENT_ACTION_KINDS, ONBOARDING_STEPS, STANDING_STATES, START_PAGES } from "@agenteschat/engine";
import { CONTEXT_LIMITS, MODEL_TIERS, PROVIDER_IDS } from "@agenteschat/providers";
import { z } from "@hono/zod-openapi";

/** A last message that was only a GIF or a sticker (ADR 0091): the apps say which, translated, in its preview. */
export const MediaKind = z.enum(["gif", "sticker"]).nullable().openapi({
  description:
    "The message was only a GIF or a sticker (ADR 0091): show `GIF` or `Sticker` in the reader's language where its text would be. Null for a message with text.",
});

/** A last-message preview's `meta`: what the app needs to show a server-written body in the reader's language. */
export const PreviewMeta = z.record(z.string(), z.unknown()).nullable().openapi({
  description:
    "For a body the server wrote (`bodyCode` + `bodyParams`, a cut-off run's notes, memory lines): show it in the reader's language, like the message itself. `media`: the message's GIF or sticker (ADR 0091), as `meta.media`, for a preview with no text. Null for a plain message.",
});

export const Role = z.enum(["owner", "member"]).openapi("Role", {
  description:
    "Whether the person owns the workspace (ADR 0085). What a member may do comes from their roles (`roleIds`, `GET …/roles`) and is sent resolved as `permissions`.",
});

/** One person's resolved permissions in a workspace (ADR 0085): the apps hide what's not there. */
const Permissions = z.array(z.string()).openapi({
  description:
    "Everything this person may do here: their roles' keys and `everyone`'s, every key with `administrator`, all of them for an owner, plus `read` (any member) and `manage_owners` (owners).",
});
const Rank = z.number().int().nullable().openapi({
  description: "Their highest role's position (0 the top), null with none. They manage roles and people below it.",
});
const RoleIds = z.array(z.string()).openapi({ description: "Their roles (`org_roles` ids), not `everyone`." });

export const ProviderId = z.enum(PROVIDER_IDS).openapi("ProviderId");

export const ModelTier = z.enum(MODEL_TIERS as ["small", "medium", "large"]);

export const StartChoice = z
  .object({
    page: z.enum(START_PAGES),
    channelId: z.uuid().nullable().openapi({ description: "With `channel`, else null." }),
  })
  .openapi("StartChoice", {
    description:
      "What opens when the app starts here (ADR 0108): `home` (Início, Conversas on the phone), `last` (where the person was, kept on each device) or `channel` (open the home when they are no longer in it).",
  });

export const Organization = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: Role,
    permissions: Permissions,
    rank: Rank,
    context: z.string().optional(),
    logo: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "The workspace logo (`/api/app/org-logos/…`); null = the agent mark." }),
    standing: z
      .object({
        state: z.enum(STANDING_STATES),
        reason: z.string().nullable().openapi({ description: "Only when the workspace is told why; else null." }),
        cloud: z.literal(true).optional().openapi({
          description:
            "agentes.chat Cloud: the apps read `review` as the automatic review hold's line (`review.<category>` naming what was flagged), and add how to contest a reason.",
        }),
      })
      .optional()
      .openapi({ description: "In `GET /me` (ADR 0056 §8). Changes come as `org.standing` org events." }),
    onboarding: z
      .object({
        step: z.enum(ONBOARDING_STEPS).openapi({ description: "The furthest step reached: where it resumes." }),
        generalChannelId: z
          .uuid()
          .openapi({ description: "#general, where the onboarding puts the agents and posts the first message." }),
      })
      .optional()
      .openapi({
        description:
          "In `GET /me`, to its owner only, while the workspace's onboarding isn't finished: the apps open the onboarding, which resumes it, instead of the workspace (`PATCH …/onboarding` saves it). Absent: finished, or not theirs to set up.",
      }),
    deletion: z
      .object({
        dueAt: z.string().nullable().openapi({
          description: "When it goes for good; null once that date passed, when it is only being deleted.",
        }),
        requestedAt: z.string().nullable(),
        requestedBy: z
          .object({ id: z.string(), name: z.string() })
          .nullable()
          .openapi({ description: "Who deleted it; null once their account is gone." }),
      })
      .optional()
      .openapi({
        description:
          "In `GET /me`, while an owner's deletion is pending: the workspace is closed (`org.deleting`), and any owner can restore it until `dueAt` (`DELETE …/deletion`). Absent: not being deleted.",
      }),
    start: StartChoice.optional().openapi({
      description: "In `GET /me`: what opens when the app starts here (`PUT …/me/start`). Absent elsewhere.",
    }),
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
    roleIds: RoleIds,
    joinedAt: z.string(),
    handle: z.string(),
    timezone: z.string(),
  })
  .openapi("Member");

export const Invitation = z
  .object({ id: z.uuid(), email: z.string(), role: Role, roleIds: RoleIds, expiresAt: z.string() })
  .openapi("Invitation");

export const Credential = z
  .object({
    id: z.uuid(),
    provider: ProviderId,
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

/**
 * Who can talk to an agent. `userIds` and `roleIds` for `people` (under `owner`: the ones a plan kept out); the owner
 * always can. A role lets in whoever holds it at the time; `everyone` isn't one to pick (that's `mode: everyone`).
 */
export const AgentAudience = z
  .object({
    mode: z.enum(["everyone", "people", "owner"]),
    userIds: z.array(z.string()).max(500),
    roleIds: z
      .array(z.uuid())
      .max(100)
      .optional()
      .openapi({ description: "Absent (older apps): a change keeps the roles already picked." }),
    consultable: z.boolean().optional().openapi({
      description:
        "Other agents may consult it for people outside this audience; it answers them, never those people. On by default; absent = keep. A plan answering only its owner (ADR 0059 §5) still keeps them out.",
    }),
  })
  .openapi("AgentAudience");

export const AgentAppearance = z
  .object({
    color: z.union([
      z.enum(["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"]),
      z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .openapi({ description: 'A custom color ("Personalizar"), stored lowercase.' }),
    ]),
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

export const PlanWindow = z.object({
  kind: z.enum(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "monthly", "other"]),
  label: z.string().optional().openapi({ description: "`other`: the provider's name for it." }),
  usedPercent: z.number().openapi({ description: "0–100." }),
  resetsAt: z.string().optional(),
});

export const PlanUsage = z
  .object({
    windows: z.array(PlanWindow),
    limited: z.boolean().optional().openapi({ description: "The plan refused a request for its limit." }),
    source: z.enum(["turn", "probe"]),
    at: z.string().openapi({ description: "When the computer learned it." }),
  })
  .openapi("PlanUsage", {
    description: "A plan's usage limits, as the CLI on the computer said them (no token is ever read).",
  });

/** An agent no longer in the team (archived or deleted, ADR 0082): what its messages and reports still show. */
export const FormerAgent = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: z.string(),
    appearance: AgentAppearance.nullable(),
    deleted: z.boolean().openapi({ description: "Deleted for good; false: archived (an admin may still delete it)." }),
  })
  .openapi("FormerAgent");

export const Agent = z
  .object({
    id: z.uuid(),
    name: z.string(),
    handle: z.string(),
    previousHandles: z.array(z.string()).optional().openapi({
      description:
        "Handles it had before a rename that still reach it (mentions, tools), so an old message's @ shows it (in the agent list and after an edit).",
    }),
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
    mediaReplies: z.boolean().openapi({
      description:
        "It may send a sticker or a GIF (ADR 0091): when someone asks for one, and after a light reply as often as the workspace's `agentMedia` allows.",
    }),
    coordinator: z.boolean().openapi({
      description:
        "It coordinates the team (ADR 0093): a message that needs an agent and that no other agent took goes to it, in the channels where it answers on its own. One per workspace.",
    }),
    brain: z
      .object({
        kind: z.enum(["model", "claude_code", "codex"]),
        model: z
          .string()
          .nullable()
          .openapi({ description: "A computer brain's model label (Sonnet); null = the agent's model." }),
        computer: z.string().optional().openapi({ description: "Its computer's name (admins and the agent's owner)." }),
        provider: z.string().optional().openapi({
          description: "A coding plan it thinks with through Claude Code (`zai`, `kimi`…): its maker's model.",
        }),
        account: z.string().optional().openapi({
          description:
            "On a plan: the account it thinks with (`Claude Team 2`; a computer's own sign-in by its plan, `Claude Max`).",
        }),
        usage: PlanUsage.optional().openapi({
          description: "On a plan: that account's limits as last reported (ADR 0063 §5); absent: not known yet.",
        }),
      })
      .optional()
      .openapi({ description: "Who thinks for it (ADR 0032), to show next to its name." }),
  })
  .openapi("Agent");

/** A named group of channels in the sidebar, the same for everyone in the organization. */
export const ChannelCategory = z
  .object({
    id: z.uuid(),
    name: z.string(),
    position: z.number().int().openapi({ description: "Order in the sidebar, from 0." }),
  })
  .openapi("ChannelCategory");

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
    categoryId: z
      .uuid()
      .nullable()
      .optional()
      .openapi({ description: "Its sidebar category; null: on top, with none." }),
    position: z.number().int().optional().openapi({ description: "Order inside its category, from 0." }),
    unreadCount: z.number().int().optional().openapi({
      description:
        "Channel list only: messages since you last read it (since you joined, if never), not yours; a thread reply counts only in a thread you follow; an agent's sticker or GIF after its own reply never (ADR 0091). At most 100; 0 when you're not a member.",
    }),
    lastMessage: z
      .object({
        id: z.uuid(),
        authorType: z.enum(["person", "agent"]),
        authorId: z.string().nullable(),
        authorName: z.string().nullable().openapi({ description: "Null when the author was deleted." }),
        preview: z.string().openapi({ description: "Plain text, at most 140 characters." }),
        meta: PreviewMeta,
        mediaKind: MediaKind,
        createdAt: z.string(),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          "Channel list only: the latest top-level message (an agent's sticker or GIF after its own reply is part of that reply, so the reply shows); null when empty or you're not a member.",
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
      .enum(AGENT_ACTION_KINDS)
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
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.null(),
          z.array(z.string()),
          z.record(z.string(), z.unknown()),
        ]),
      )
      .openapi({
        description:
          "Values for the sentence (number, title, fields, status, text, agentName…); a routine's `rule` is an object the app words.",
      }),
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
          reason: z
            .literal("no_ai")
            .optional()
            .openapi({ description: "It couldn't answer: the agent has no AI connected." }),
          outage: z
            .literal(true)
            .optional()
            .openapi({ description: "`waiting_input` because its AI provider is down: it retries by itself." }),
        }),
      ),
      blocked: z
        .array(z.uuid())
        .openapi({ description: "Agents it mentions that won't answer (they don't reply to this person)." }),
      referenced: z
        .array(z.uuid())
        .optional()
        .openapi({ description: "Agents it only references as part of the request to another agent: no run." }),
      noAi: z
        .literal(true)
        .optional()
        .openapi({ description: "Routed to nobody: the organization had no AI connected." }),
      platformCap: z.literal(true).optional().openapi({
        description: "Routed to nobody: the workspace used up its platform AI for the month; @mentions still answer.",
      }),
      decidedBy: z
        .union([
          z.object({ step: z.literal("jev") }),
          z.object({ step: z.literal("model"), model: z.string(), provider: z.string() }),
          z.object({ step: z.literal("plan"), brand: z.enum(["claude", "chatgpt"]), ownerId: z.string() }),
          z.object({
            step: z.literal("rule"),
            rule: z.enum(["reply", "only_agent", "follow_up", "coordinator", "default"]),
          }),
        ])
        .optional()
        .openapi({
          description:
            "Who picked the agents for a message nobody mentioned (ADR 0074): Jev, a small model, the author's own plan (`ownerId`), or a rule (`coordinator`: nobody else took it, so the team's coordinator did, ADR 0093). Absent before the chain.",
        }),
      reason: z
        .literal("mention_needed")
        .optional()
        .openapi({ description: "No step could read it and no rule fit: only a mention reaches an agent." }),
    })
    .optional()
    .openapi({ description: "People's messages: agents that saw it, picked it up, and how their runs ended." }),
  meta: z.record(z.string(), z.unknown()).openapi({
    description:
      'Attachments, e.g. `{ approvalId }` on an approval card (see /approvals). `media` (ADR 0091): a GIF `{ kind: "gif", provider, id, title, width, height }` (load it with `GET …/gifs/{id}/media`) or a sticker `{ kind: "sticker", agentId, mood }`, and the body may be empty then. `mediaAfter`: on the sticker or GIF an agent added after its own reply, that reply\'s id.',
  }),
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
    contextWindow: z.number().int().openapi({ description: "Its context window in tokens." }),
    inputUsdPerMTok: z.number(),
    outputUsdPerMTok: z.number(),
    pick: z.boolean().optional().openapi({
      description: "In OpenRouter's long list (ADR 0087): a good pick, shown first. Absent: a catalog model.",
    }),
    tier: ModelTier.optional().openapi({
      description: "The size Automático uses it for on its provider's key, by default.",
    }),
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
        contextWindow: z
          .number()
          .int()
          .optional()
          .openapi({ description: "Its context window in tokens: the context limits worth offering with it." }),
      }),
    ),
    defaultModel: z.string().nullable(),
  })
  .openapi("BrainOption");

export const BrainEffort = z.enum(BRAIN_EFFORTS).openapi("BrainEffort", {
  description: "How hard a computer brain thinks (Claude Code `--effort`; Codex maps `xhigh` and `max` to `high`).",
});

/** The effort setting: a level, or `auto` (picked per run with the model tier). */
export const BrainEffortSetting = z.enum([...BRAIN_EFFORTS, "auto"]).openapi("BrainEffortSetting", {
  description: "A `BrainEffort`, or `auto`: the judge picks low, medium or high for each run.",
});

/** The context limits an agent may choose (`CONTEXT_LIMITS`), in tokens. */
export const ContextLimit = z
  .literal(CONTEXT_LIMITS)
  .openapi("ContextLimit", { description: "The most context an agent reads, in tokens: 200000, 400000 or 1000000." });

export const CommandApproval = z.enum(["always", "low_risk_auto", "never"]).openapi({
  description:
    '"Pedir aprovação de comandos": always (every command off the allow list asks), low_risk_auto (the judge allows low-risk ones within what code allows) or never (everything but the deny list).',
});

export const AccountKind = z.enum(ACCOUNT_KINDS).openapi("AccountKind");

export const MachineAccount = z
  .object({
    id: z.uuid(),
    kind: AccountKind,
    label: z.string(),
    email: z.string().nullable().openapi({ description: "Only for its owner." }),
    plan: z
      .string()
      .nullable()
      .openapi({ description: "`pro`, `max`, `ultra`, `team`, `enterprise`… from what the CLI says." }),
    status: z.enum(["active", "signed_out"]),
    ownerId: z.string().nullable().openapi({ description: "Whose account it is; null: nobody's." }),
    ownerName: z.string().nullable(),
    mine: z.boolean().openapi({ description: "The caller owns it: only they rename it or choose it for an agent." }),
    usedBy: z.array(z.string()).openapi({
      description: "Names of the agents that think with it (one at most, unless `shared`).",
    }),
    usedByIds: z.array(z.uuid()).openapi({ description: "Their ids, in the same order." }),
    usage: PlanUsage.nullable().openapi({ description: "Its plan's usage limits; null: not known yet." }),
    provider: z.string().nullable().openapi({
      description: "A key account's coding plan (`zai`, `kimi`, `minimax`, `opencode`); null: the CLI's own sign-in.",
    }),
    keyHint: z.string().nullable().openapi({ description: "The last 4 of a key account's key; only for its owner." }),
    shared: z.boolean().openapi({
      description:
        "It thinks for every agent its owner gives it on that computer, with no new sign-in (runner protocol 29); else for one.",
    }),
  })
  .openapi("MachineAccount", {
    description:
      "An account of a computer brain on a connected computer (ADR 0041, ADR 0059). Metadata only, never a sign-in.",
  });

/** A computer the caller may give an agent, with what it offers. */
export const BrainMachine = z
  .object({ machineId: z.uuid(), name: z.string(), online: z.boolean(), options: z.array(BrainOption) })
  .openapi("BrainMachine");

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
    machines: z.array(BrainMachine).openapi({
      description:
        "Every computer the caller may give the agent (admins: all; its owner: the ones they connected), with what each offers.",
    }),
    canEdit: z.boolean(),
    account: z
      .uuid()
      .nullable()
      .openapi({ description: "The account its computer brain runs with (ADR 0041); null = the computer's own." }),
    effort: BrainEffortSetting.nullable().openapi({ description: "`auto` = per run; null = the CLI's default." }),
    contextTokens: ContextLimit.nullable().openapi({
      description: "The most context it reads, any brain; null = its model's window (the smaller one wins).",
    }),
    accounts: z.array(MachineAccount).openapi({
      description: "The agent's owner's accounts on its computer, both kinds, and the one it thinks with (ADR 0059).",
    }),
    canManageAccounts: z.boolean().openapi({
      description:
        "The caller may add an account there for this agent: its owner, on a computer where they add accounts.",
    }),
    accountsSupported: z.boolean().openapi({ description: "The computer's runner knows accounts (protocol 13)." }),
    onlyOwner: z.boolean().openapi({ description: '"Atende outras pessoas" off: nobody but its owner talks to it.' }),
    canUsePlans: z.boolean().openapi({
      description: "The caller owns the agent: only they choose its plan and let other people talk to it on a plan.",
    }),
    ownSignIn: z.boolean().openapi({
      description: "The computer's own sign-in can think for it: the person who connected the computer owns the agent.",
    }),
    ownUsage: z
      .object({ claude_code: PlanUsage.optional(), codex: PlanUsage.optional() })
      .openapi({ description: "The computer's own sign-ins' usage limits, by brain (absent: not known)." }),
    autonomy: CommandApproval.openapi({
      description:
        'Its Autonomia: the autonomy its new missions start with ("Usar como padrão"), copied with its setup.',
    }),
  })
  .openapi("AgentBrain");

/** ADR 0094: one agent's "Quem pensa" as a value, to use on other agents. */
export const AgentSetup = z
  .object({
    brain: BrainKind,
    model: z.string().max(80).nullable().openapi({
      description:
        "The API brain: the agent's model (`auto` or a catalog id). A computer brain: its model as `PUT …/brain` takes it; null = the brain's default.",
    }),
    key: z.uuid().nullable().optional().openapi({
      description: "The API brain's key; null = the workspace's default; omitted = each agent keeps its own.",
    }),
    machineId: z.uuid().nullable().optional().openapi({ description: "A computer brain: the computer it thinks on." }),
    account: z
      .uuid()
      .nullable()
      .optional()
      .openapi({ description: "A computer brain: the account there; null = that computer's own sign-in." }),
    effort: BrainEffortSetting.nullable().optional(),
    contextTokens: ContextLimit.nullable().optional(),
    fallback: z.boolean().optional(),
    onlyOwner: z.boolean().optional().openapi({
      description:
        '"Atende outras pessoas" off, for the agents that move onto the plan (only the plan\'s owner turns it on).',
    }),
    autonomy: CommandApproval.optional().openapi({
      description:
        "Its Autonomia, set wherever the caller may set it by hand (an admin or the agent's owner), whatever the AI takes; omitted = each agent keeps its own.",
    }),
  })
  .openapi("AgentSetup");

export const AgentSetupResult = z
  .object({
    agentId: z.uuid(),
    status: z.enum(["applied", "same", "skipped"]).openapi({
      description:
        "Its AI: `applied` (in a preview: would be); `same`: it already thinks this way; `skipped`: it takes none of the AI (`reason`), and may still take the Autonomia (`autonomy`).",
    }),
    autonomy: z.object({ from: CommandApproval, to: CommandApproval }).optional().openapi({
      description:
        "Its Autonomia changes (in a preview: would), whatever its AI does: wherever the caller may set it by hand, `skipped` agents too.",
    }),
    keeps: z.object({ account: z.string().nullable() }).optional().openapi({
      description: "It keeps the account it has (another person's plan): its name; null = its computer's own.",
    }),
    reason: z
      .enum([
        "not_allowed",
        "admins_only",
        "account_owner",
        "account_single",
        "other_computer",
        "model_missing",
        "failed",
      ])
      .optional(),
    params: z.record(z.string(), z.string()).optional(),
  })
  .openapi("AgentSetupResult");

export const NewAgentSetup = z
  .object({
    brain: BrainKind,
    model: z.string().nullable(),
    key: z.uuid().nullable(),
    contextTokens: ContextLimit.nullable(),
    computer: z.object({ machineId: z.uuid(), name: z.string() }).optional(),
    account: z
      .object({
        id: z.uuid(),
        label: z.string(),
        provider: z.string().nullable(),
        mine: z.boolean(),
        free: z.boolean().openapi({
          description: "It can think for one more agent (made for all its owner's agents, or used by none).",
        }),
      })
      .nullable()
      .optional(),
    ownSignIn: z
      .boolean()
      .optional()
      .openapi({ description: "The computer's own sign-in thinks for the caller's agents (they connected it)." }),
    effort: BrainEffortSetting.nullable().optional(),
    fallback: z.boolean().optional(),
    autonomy: CommandApproval.nullable().openapi({
      description:
        "Its Autonomia; null = the default. `POST …/agents` takes it only from an admin or the new agent's owner.",
    }),
  })
  .openapi("NewAgentSetup", {
    description: "What a new agent starts thinking with (ADR 0094): the last setup saved or used on other agents.",
  });

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
