import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import {
  announceMessageMemories,
  type ContextItem,
  decideProposal,
  editContextItem,
  getAgent,
  itemVisibleIn,
  listAgentMemoryRows,
  listProposals,
  NotFoundError,
  type Proposal as ProposalRow,
  requirePermission,
  revertMemoryChange,
  userVisibleChannels,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Knowledge"];

const Memory = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    kind: z.enum(["fact", "decision", "lesson", "preference"]),
    text: z.string(),
    source: z.string().openapi({ example: "Learned in #eng · Oct 12" }),
    origin: z
      .object({
        by: z.enum(["person", "agent", "lesson", "recorded"]),
        name: z.string().nullable().openapi({ description: "The person who wrote it (`by: person`)." }),
        channel: z.string().nullable().openapi({ description: "Channel name, without `#`." }),
        at: z.string(),
      })
      .optional()
      .openapi({ description: "`source` in parts, for the app to say it in its language (`source` is English)." }),
    uses: z.number(),
    lastUsedAt: z.string().nullable(),
    pinned: z.boolean(),
    archived: z.boolean(),
    lowTrust: z
      .boolean()
      .openapi({ description: "Came from outside the team (webhook, tool output, public comment)." }),
    verified: z.boolean().openapi({ description: "Backed by an outcome or a person; agent claims alone are not." }),
    supersedes: z.string().nullable().openapi({ description: "The text this one replaced." }),
    editedByUserId: z.string().nullable(),
    updatedAt: z.string(),
    from: z
      .object({
        messageId: z.uuid(),
        channelId: z.uuid(),
        threadId: z.string().nullable(),
        dm: z.boolean().openapi({ description: "Said in a direct conversation." }),
        at: z.string(),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          '`?about=me` only: the viewer\'s message it came from (newest), to say "Você disse hoje, nesta conversa".',
      }),
  })
  .openapi("Memory");

const Proposal = z
  .object({
    id: z.uuid(),
    agentId: z.string(),
    target: z.union([
      z.object({ type: z.literal("agent_instructions"), agentId: z.string() }),
      z.object({ type: z.literal("org_context") }),
    ]),
    title: z.string(),
    why: z.string(),
    evidence: z.array(
      z.object({
        where: z.string(),
        what: z.string(),
        channelId: z.string().nullable().optional(),
        type: z.enum(["outcome", "human", "agent", "self"]).optional().openapi({
          description: "Where the evidence came from; the app translates it (`where` is the English text).",
        }),
      }),
    ),
    before: z.string(),
    after: z.string(),
    status: z.enum(["pending", "accepted", "refused"]),
    stale: z.boolean().openapi({ description: "The text changed since; accepting is no longer possible." }),
    decider: z.union([
      z.object({ type: z.literal("user"), userId: z.string(), name: z.string() }),
      z.object({ type: z.literal("admins") }),
    ]),
    canDecide: z.boolean(),
    createdAt: z.string(),
    decidedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
    decidedAt: z.string().nullable(),
  })
  .openapi("Proposal");

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });

const KIND: Record<ContextItem["kind"], z.infer<typeof Memory>["kind"]> = {
  fact: "fact",
  decision: "decision",
  lesson: "lesson",
  preference: "preference",
  note: "fact",
  open_question: "fact",
  entity_profile: "fact",
  thread_summary: "fact",
  period_summary: "fact",
};

/** `items` must be visible to the viewer; `visible` (the channels they read) also bounds the old versions shown. */
async function memoryViews(db: Database, items: ContextItem[], visible: readonly string[]) {
  if (items.length === 0) return [];
  const channelIds = [...new Set(items.flatMap((i) => i.channelIds))];
  const channels = channelIds.length
    ? await db
        .select({ id: schema.channels.id, name: schema.channels.name })
        .from(schema.channels)
        .where(inArray(schema.channels.id, channelIds))
    : [];
  const channelName = new Map(channels.map((c) => [c.id, c.name]));
  const replaced = await db
    .select({
      supersededBy: schema.contextItems.supersededBy,
      content: schema.contextItems.content,
      channelIds: schema.contextItems.channelIds,
    })
    .from(schema.contextItems)
    .where(
      inArray(
        schema.contextItems.supersededBy,
        items.map((i) => i.id),
      ),
    );
  // A version merged in from a channel the viewer can't read isn't quoted.
  const previous = new Map(replaced.filter((r) => itemVisibleIn(r, visible)).map((r) => [r.supersededBy, r.content]));
  const people = items.flatMap((i) => (i.createdByKind === "person" && i.createdById ? [i.createdById] : []));
  const names = new Map(
    (people.length
      ? await db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, people))
      : []
    ).map((u) => [u.id, u.name]),
  );
  return items.map((i) => {
    const channel = i.channelIds[0] ? (channelName.get(i.channelIds[0]) ?? null) : null;
    const where = i.channelIds[0] ? ` in #${channel ?? "channel"}` : "";
    const name = i.createdByKind === "person" ? (names.get(i.createdById ?? "") ?? null) : null;
    const by =
      i.createdByKind === "person"
        ? ("person" as const)
        : i.createdByKind === "agent"
          ? ("agent" as const)
          : i.kind === "lesson"
            ? ("lesson" as const)
            : ("recorded" as const);
    const how = {
      person: `Written by ${name ?? "a person"}`,
      agent: "Noted by the agent",
      lesson: "Learned",
      recorded: "Recorded",
    }[by];
    return {
      id: i.id,
      agentId: i.agentId ?? "",
      kind: KIND[i.kind],
      text: i.content,
      source: `${how}${where} · ${shortDate(i.createdAt)}`,
      origin: { by, name, channel, at: i.createdAt.toISOString() },
      uses: i.useCount,
      lastUsedAt: i.lastUsedAt ? i.lastUsedAt.toISOString() : null,
      pinned: i.pinned,
      archived: i.status === "archived",
      lowTrust: i.trust === "low",
      verified: i.verified,
      supersedes: previous.get(i.id) ?? null,
      editedByUserId: i.createdByKind === "person" ? i.createdById : null,
      updatedAt: i.updatedAt.toISOString(),
    };
  });
}

/** What "O que sabe sobre você" lists (summaries and open questions are the agent's own bookkeeping). */
const ABOUT_KINDS = new Set<ContextItem["kind"]>(["fact", "decision", "lesson", "preference", "note"]);

/** Items saved from the viewer's own messages → the newest such message (where and when they said it). */
async function viewerSources(db: Database, orgId: string, viewerId: string, items: ContextItem[]) {
  const out = new Map<
    string,
    { messageId: string; channelId: string; threadId: string | null; dm: boolean; at: string }
  >();
  const ids = [...new Set(items.flatMap((i) => i.sourceIds))];
  if (ids.length === 0) return out;
  const said = await db
    .select({
      id: schema.messages.id,
      channelId: schema.messages.channelId,
      threadId: schema.messages.threadId,
      createdAt: schema.messages.createdAt,
      kind: schema.channels.kind,
    })
    .from(schema.messages)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
    .where(
      and(
        eq(schema.messages.orgId, orgId),
        inArray(schema.messages.id, ids),
        eq(schema.messages.authorType, "person"),
        eq(schema.messages.authorUserId, viewerId),
      ),
    );
  const byId = new Map(said.map((m) => [m.id, m]));
  for (const item of items) {
    const newest = item.sourceIds
      .flatMap((id) => (byId.get(id) ? [byId.get(id) as (typeof said)[number]] : []))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!newest) continue;
    out.set(item.id, {
      messageId: newest.id,
      channelId: newest.channelId,
      threadId: newest.threadId,
      dm: newest.kind === "dm",
      at: newest.createdAt.toISOString(),
    });
  }
  return out;
}

/** Lines kept or removed in the diff = the text before. */
const beforeOf = (diff: string) =>
  diff
    .split("\n")
    .filter((l) => l.startsWith(" ") || l.startsWith("-"))
    .map((l) => l.slice(1))
    .join("\n");

async function proposalViews(db: Database, rows: (ProposalRow & { canDecide: boolean })[]) {
  const agentIds = [...new Set(rows.flatMap((r) => (r.agentId ? [r.agentId] : [])))];
  const agents = agentIds.length
    ? await db.select().from(schema.agents).where(inArray(schema.agents.id, agentIds))
    : [];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const userIds = [
    ...new Set([
      ...agents.flatMap((a) => (a.ownerUserId ? [a.ownerUserId] : [])),
      ...rows.flatMap((r) => (r.decidedByUserId ? [r.decidedByUserId] : [])),
    ]),
  ];
  const users = new Map(
    (userIds.length
      ? await db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, userIds))
      : []
    ).map((u) => [u.id, u.name]),
  );
  const itemIds = [...new Set(rows.flatMap((r) => r.itemIds))];
  const items = itemIds.length
    ? await db.select().from(schema.contextItems).where(inArray(schema.contextItems.id, itemIds))
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));
  const evidenceLabel = {
    outcome: "Observed outcome",
    human: "A person",
    agent: "Another agent",
    self: "The agent itself",
  };
  return rows.map((r) => {
    const agent = r.agentId ? agentById.get(r.agentId) : undefined;
    const owner = agent?.ownerUserId;
    const sourceItems = r.itemIds.flatMap((id) => (itemById.get(id) ? [itemById.get(id) as ContextItem] : []));
    return {
      id: r.id,
      agentId: r.agentId ?? "",
      target:
        r.target === "agent_instructions" && r.agentId
          ? { type: "agent_instructions" as const, agentId: r.agentId }
          : { type: "org_context" as const },
      title:
        r.target === "agent_instructions"
          ? `Update ${agent?.name ?? "the agent"}'s instructions`
          : "Update the organization context",
      why: sourceItems.map((i) => i.content).join(" ") || r.rationale,
      evidence: sourceItems.flatMap((i) =>
        i.evidence.map((e) => ({
          where: evidenceLabel[e.type],
          what: i.content,
          channelId: i.channelIds[0] ?? null,
          type: e.type,
        })),
      ),
      before: beforeOf(r.diff),
      after: r.proposedText,
      status:
        r.status === "accepted"
          ? ("accepted" as const)
          : r.status === "pending"
            ? ("pending" as const)
            : ("refused" as const),
      stale: r.status === "stale",
      decider:
        r.target === "agent_instructions" && owner
          ? { type: "user" as const, userId: owner, name: users.get(owner) ?? "" }
          : { type: "admins" as const },
      canDecide: r.canDecide,
      createdAt: r.createdAt.toISOString(),
      decidedBy: r.decidedByUserId ? { userId: r.decidedByUserId, name: users.get(r.decidedByUserId) ?? "" } : null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    };
  });
}

/** "O que a Ada sabe" and improvement proposals, in the shapes the web app uses. */
export function memoryRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/memories",
      tags,
      security,
      summary: "What an agent knows: its notes and lessons (archived included, flagged)",
      description:
        "`about=me`: only what came from the viewer (saved from their messages, or written by them), " +
        "each with `from` (the message it came from).",
      request: {
        params: OrgParams.extend({ agentId: z.uuid() }),
        query: z.object({ about: z.enum(["me"]).optional() }),
      },
      responses: { 200: json(z.object({ memories: z.array(Memory) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const viewerId = c.get("user").id;
      await requirePermission(db, viewerId, orgId, "read");
      if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
      // Only what the viewer may see: items learned in a DM or private channel they can't read stay out.
      const { items: rows, visible } = await listAgentMemoryRows(db, viewerId, orgId, agentId);
      const current = rows
        .filter((r) => !r.supersededBy)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.getTime() - a.updatedAt.getTime());
      if (c.req.valid("query").about !== "me")
        return c.json({ memories: await memoryViews(db, current, visible) }, 200);
      const mine = await viewerSources(db, orgId, viewerId, current);
      const about = current.filter(
        (i) =>
          ABOUT_KINDS.has(i.kind) && (mine.has(i.id) || (i.createdByKind === "person" && i.createdById === viewerId)),
      );
      const views = await memoryViews(db, about, visible);
      return c.json({ memories: views.map((v) => ({ ...v, from: mine.get(v.id) ?? null })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/memories/{memoryId}",
      tags,
      security,
      summary: "Edit (keeps history), pin or archive a memory (agent owner or admin)",
      request: {
        params: OrgParams.extend({ memoryId: z.uuid() }),
        body: body(
          z.object({
            text: z.string().min(1).max(8000).optional(),
            pinned: z.boolean().optional(),
            archived: z.boolean().optional(),
          }),
        ),
      },
      responses: { 200: json(Memory), ...errors },
    }),
    async (c) => {
      const { orgId, memoryId } = c.req.valid("param");
      const input = c.req.valid("json");
      const row = await editContextItem(db, c.get("user").id, orgId, memoryId, {
        content: input.text,
        pinned: input.pinned,
        archived: input.archived,
      });
      // The memory mark on the message it came from changes for everyone in the channel.
      await announceMessageMemories({ db, pubsub: deps.adapters.pubsub }, orgId, row).catch(() => {});
      const [view] = await memoryViews(db, [row], await userVisibleChannels(db, orgId, c.get("user").id));
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/memories/{memoryId}/revert",
      tags,
      security,
      summary: "Undo a memory change made in conversation (forgotten → back, updated → previous, new → archived)",
      request: { params: OrgParams.extend({ memoryId: z.uuid() }), body: body(z.object({})) },
      responses: { 200: json(Memory), ...errors },
    }),
    async (c) => {
      const { orgId, memoryId } = c.req.valid("param");
      const row = await revertMemoryChange(db, c.get("user").id, orgId, memoryId);
      await announceMessageMemories({ db, pubsub: deps.adapters.pubsub }, orgId, row).catch(() => {});
      const [view] = await memoryViews(db, [row], await userVisibleChannels(db, orgId, c.get("user").id));
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/proposals",
      tags,
      security,
      summary: "Improvement proposals for agent instructions or the org context",
      request: {
        params: OrgParams,
        query: z.object({
          status: z.enum(["pending", "accepted", "refused"]).optional(),
          agentId: z.uuid().optional(),
        }),
      },
      responses: { 200: json(z.object({ proposals: z.array(Proposal) })), ...errors },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const rows = await listProposals(db, c.get("user").id, c.req.valid("param").orgId, {
        agentId: q.agentId,
        status: q.status === "refused" ? "rejected" : q.status,
      });
      return c.json({ proposals: await proposalViews(db, rows) }, 200);
    },
  );

  for (const decision of ["accept", "refuse"] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/proposals/{proposalId}/${decision}`,
        tags,
        security,
        summary:
          decision === "accept"
            ? "Accept (optionally with adjusted text, applied server-side). 409 when the text changed since."
            : "Refuse",
        request: {
          params: OrgParams.extend({ proposalId: z.uuid() }),
          body: body(z.object({ text: z.string().max(50_000).optional() })),
        },
        responses: { 200: json(Proposal), ...errors },
      }),
      async (c) => {
        const { orgId, proposalId } = c.req.valid("param");
        const actorId = c.get("user").id;
        await decideProposal(db, actorId, orgId, proposalId, decision === "accept" ? "accept" : "reject", {
          finalText: decision === "accept" ? c.req.valid("json").text : undefined,
        });
        const [row] = (await listProposals(db, actorId, orgId)).filter((p) => p.id === proposalId);
        if (!row) throw new NotFoundError("Proposal not found");
        const [view] = await proposalViews(db, [row]);
        return c.json(view, 200);
      },
    );
  }

  return app;
}
