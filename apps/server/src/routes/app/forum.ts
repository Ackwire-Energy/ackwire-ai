import {
  acceptForumSuggestion,
  cancelForumTopic,
  concludeForumTopic,
  createForumIssues,
  createForumTopic,
  dismissForumSuggestion,
  type ForumDeps,
  type ForumOriginInput,
  getForumTopic,
  listForumTopics,
  passForumTurn,
  postInForumAsPerson,
  resumeForumTopic,
  setForumParticipants,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Forum"];
const Status = z.enum(["open", "stalled", "done", "canceled"]);
const Phase = z.enum(["discussing", "waiting_person", "synthesizing", "finished"]);
const Format = z.enum(["decision", "plan"]);
const Actor = z.object({ type: z.enum(["person", "agent"]), id: z.string() });
const Seat = z
  .object({ type: z.enum(["agent", "person"]), id: z.string().min(1).max(100) })
  .openapi("ForumSeat", { description: "A place at the table: an agent, or a person who sat down." });
const Owner = z.object({ type: z.enum(["agent", "person"]), id: z.string() });
const SuggestedIssue = z
  .object({
    title: z.string().min(1).max(300),
    description: z.string().max(5000),
    step: z.number().int().min(1).max(50).optional().openapi({ description: "The plan step it comes from." }),
    owner: Owner.nullable().optional().openapi({ description: "Becomes the assignee when the issue is created." }),
  })
  .openapi("ForumSuggestedIssue");
const Stance = z
  .object({
    kind: z.enum(["propose", "agree", "disagree", "shift", "ask", "reply"]),
    target: z
      .object({ type: z.enum(["agent", "person", "people"]), id: z.string().optional(), handle: z.string().optional() })
      .optional(),
  })
  .openapi("ForumStance");
const TrackStatus = z.enum([
  "spoke",
  "skipped_budget",
  "passed",
  "skipped",
  "stopped",
  "failed",
  "live",
  "waiting",
  "pending",
]);
const Track = z
  .object({
    rounds: z.array(
      z.object({
        round: z.number(),
        personPosts: z.array(z.object({ userId: z.string(), postId: z.uuid().nullable(), length: z.number() })),
        entries: z.array(
          z.object({ seat: Seat, status: TrackStatus, postId: z.uuid().nullable(), length: z.number() }),
        ),
      }),
    ),
    synthesis: z
      .object({ agentId: z.uuid().nullable(), status: z.enum(["live", "done", "stalled"]), revision: z.number() })
      .nullable(),
  })
  .openapi("ForumTrack", {
    description:
      "The round track: for each round (up to `rounds`), each seat's turn in order, and people's free posts that lead it.",
  });
const Owned = { owner: Owner.nullable(), ownerLabel: z.string().nullable() };
const Structured = z
  .union([
    z.object({
      format: z.literal("decision"),
      decision: z.string(),
      reasons: z.array(z.string()).optional(),
      positions: z.array(
        z.object({
          agentId: z.uuid().nullable(),
          name: z.string(),
          pros: z.array(z.string()),
          cons: z.array(z.string()),
        }),
      ),
      openQuestions: z.array(z.string()),
      nextSteps: z.array(z.object({ text: z.string(), ...Owned, when: z.string().nullable() })),
      suggestedIssues: z.array(SuggestedIssue),
      changes: z.array(z.string()),
    }),
    z.object({
      format: z.literal("plan"),
      objective: z.string(),
      summaryForRequester: z.string(),
      inScope: z.array(z.string()),
      outOfScope: z.array(z.string()),
      steps: z.array(
        z.object({ title: z.string(), ...Owned, after: z.number().nullable(), size: z.string().nullable() }),
      ),
      risks: z.array(z.string()),
      metrics: z.array(z.string()),
      openQuestions: z.array(z.string()),
      suggestedIssues: z.array(SuggestedIssue),
      changes: z.array(z.string()),
    }),
  ])
  .openapi("ForumSynthesisCards");
const Synthesis = z
  .object({
    artifactId: z.uuid().nullable(),
    version: z.number().openapi({ description: "The Drive document's version." }),
    revision: z.number().openapi({ description: "Which synthesis: 1, then 2… after each new round from a comment." }),
    format: Format,
    suggestedIssues: z.array(SuggestedIssue),
    structured: Structured.nullable(),
    deleted: z.boolean().optional().openapi({ description: "The synthesis file was deleted." }),
    versions: z.array(
      z.object({
        revision: z.number(),
        artifactVersion: z.number().nullable(),
        createdAt: z.string(),
        afterRound: z.number(),
        changes: z.array(z.string()),
      }),
    ),
    createdIssues: z.array(z.object({ id: z.uuid(), number: z.number(), title: z.string() })),
  })
  .openapi("ForumSynthesis");
const Topic = z
  .object({
    id: z.uuid(),
    title: z.string(),
    goal: z.string(),
    status: Status.openapi({
      description: "`stalled`: a person stopped the turn (or it failed); `resume` restarts it.",
    }),
    phase: Phase,
    format: Format,
    round: z.number().openapi({ description: "The round in progress (or the last one when finished), from 1." }),
    rounds: z.number(),
    agentIds: z.array(z.uuid()),
    userIds: z.array(z.string()),
    seats: z.array(Seat).openapi({ description: "The speaking order: agents and the people who sat down." }),
    createdBy: Actor,
    origin: z.object({
      kind: z.enum(["direct", "channel", "agent", "suggestion", "issue", "routine"]),
      channelId: z.uuid().nullable(),
      messageId: z.uuid().nullable(),
      issueId: z.uuid().nullable(),
      issueNumber: z.number().nullable(),
      routineId: z.uuid().nullable(),
      agentId: z.uuid().nullable(),
    }),
    originChannelId: z.uuid().nullable(),
    responsibleUserId: z.string().nullable().openapi({ description: '"Responsável": runs run on their behalf.' }),
    requestedByUserId: z.string().nullable().openapi({ description: '"Pedido de" (e.g. the origin issue\'s author).' }),
    ownerAgentId: z.uuid().nullable(),
    deadline: z.string().nullable(),
    waitingUserId: z.string().nullable().openapi({ description: 'The seated person whose turn it is ("Sua vez").' }),
    stall: z
      .object({
        reason: z.enum(["stopped", "failed"]),
        byUserId: z.string().nullable(),
        agentId: z.uuid().nullable(),
        round: z.number(),
        synthesis: z.boolean(),
        at: z.string(),
      })
      .nullable(),
    reopened: z.object({ byUserId: z.string(), at: z.string() }).nullable(),
    channelId: z.uuid().openapi({ description: "The topic's channel: subscribe to it for the agents' live runs." }),
    createdAt: z.string(),
    lastActivityAt: z.string(),
    activeAgentIds: z.array(z.uuid()),
    track: Track,
    synthesis: Synthesis.nullable(),
  })
  .openapi("ForumTopic");
const Post = z
  .object({
    id: z.uuid(),
    topicId: z.uuid(),
    round: z.number(),
    author: Actor,
    body: z.string(),
    agentRunId: z.uuid().nullable(),
    kind: z.enum(["turn", "free", "seat", "comment", "synthesis"]),
    stance: Stance.nullable(),
    replyTo: z.uuid().nullable(),
    position: z.string().nullable().openapi({ description: "The agent's position in one line." }),
    requestRound: z.object({ agentIds: z.array(z.uuid()).nullable() }).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string(),
  })
  .openapi("ForumPost");
const SynthesisVersion = z.object({
  revision: z.number(),
  artifactId: z.uuid().nullable(),
  artifactVersion: z.number().nullable(),
  agentId: z.string(),
  format: Format,
  afterRound: z.number(),
  createdAt: z.string(),
  structured: Structured,
  markdown: z.string(),
});
const Detail = Topic.extend({ posts: z.array(Post), syntheses: z.array(SynthesisVersion) }).openapi("ForumTopicDetail");
const TopicParams = OrgParams.extend({ topicId: z.uuid() });
const SuggestionParams = OrgParams.extend({ messageId: z.uuid() });
const Suggestion = z
  .object({
    title: z.string(),
    goal: z.string(),
    agentIds: z.array(z.uuid()),
    rounds: z.number(),
    format: Format,
    suggestedByAgentId: z.uuid(),
    state: z.enum(["pending", "accepted", "dismissed"]),
    topicId: z.uuid().nullable(),
    decidedByUserId: z.string().nullable(),
    decidedAt: z.string().nullable(),
  })
  .openapi("ForumSuggestion", { description: 'An agent\'s "Worth a forum?" card (`meta.forumSuggestion`).' });
const TableInput = {
  agentIds: z.array(z.uuid()).min(1).max(8),
  userIds: z.array(z.string()).max(50).optional(),
  rounds: z.number().int().min(1).max(10).optional(),
  deadline: z.iso.datetime().optional(),
  ownerAgentId: z.uuid().optional().openapi({ description: "Writes the synthesis (default: the first agent)." }),
  format: Format.optional(),
  seats: z.array(Seat).max(16).optional().openapi({
    description:
      "The speaking order, agents and seated people mixed (default: the agents in order). People here take turns; the rest post whenever they want.",
  }),
};

/**
 * The forum (ADR 0022): topics where agents (and seated people)
 * discuss in rounds and end with a synthesis, a decision or a plan. Everyone
 * in the organization reads it; people post at any time (their post leads
 * the next round), can ask for one more round, and conclude, cancel or
 * resume it. No money here: each agent runs on its own budget.
 */
export function forumRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const forum = (): ForumDeps => ({ db, pubsub: adapters.pubsub, artifacts: deps.extras?.artifacts });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/forum/topics",
      tags,
      security,
      summary: "Forum topics, most recent activity first",
      request: {
        params: OrgParams,
        query: z.object({
          status: Status.optional(),
          mine: z.stringbool().optional(),
          agentId: z.uuid().optional(),
        }),
      },
      responses: { 200: json(z.object({ topics: z.array(Topic) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const q = c.req.valid("query");
      const topics = await listForumTopics(db, c.get("user").id, orgId, {
        status: q.status,
        mine: q.mine,
        agentId: q.agentId,
      });
      return c.json({ topics }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/forum/topics",
      tags,
      security,
      summary: "Open a topic: agents discuss it in rounds (round 1 starts right away)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            title: z.string().min(1).max(200),
            goal: z.string().min(1).max(5000),
            ...TableInput,
            originIssueId: z.uuid().optional().openapi({
              description:
                '"Avaliar no fórum": the issue\'s author becomes "Pedido de", and the result comes back to the issue.',
            }),
            originMessageId: z
              .uuid()
              .optional()
              .openapi({ description: "From a thread: the synthesis comes back to that thread." }),
          }),
        ),
      },
      responses: { 201: json(Detail, "Created"), ...errors },
    }),
    async (c) => {
      const { originIssueId, originMessageId, deadline, ...input } = c.req.valid("json");
      const { orgId } = c.req.valid("param");
      const origin: ForumOriginInput | undefined = originIssueId
        ? { kind: "issue", issueId: originIssueId }
        : originMessageId
          ? { kind: "channel", messageId: originMessageId }
          : undefined;
      const topic = await createForumTopic(forum(), { type: "person", userId: c.get("user").id }, orgId, {
        ...input,
        deadline: deadline ? new Date(deadline) : null,
        origin,
      });
      return c.json(topic, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/forum/topics/{topicId}",
      tags,
      security,
      summary: "A topic with its posts (one per seat per round; people's posts in between) and every synthesis",
      request: { params: TopicParams },
      responses: { 200: json(Detail), ...errors },
    }),
    async (c) => {
      const { orgId, topicId } = c.req.valid("param");
      return c.json(await getForumTopic(db, c.get("user").id, orgId, topicId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/forum/topics/{topicId}/posts",
      tags,
      security,
      summary:
        "A person posts: in their seated turn it is their turn; otherwise it leads the next round. `requestRound` asks for one more round (reopens a concluded topic)",
      request: {
        params: TopicParams,
        body: body(
          z.object({
            body: z.string().min(1).max(20_000),
            requestRound: z
              .object({ agentIds: z.array(z.uuid()).max(8).optional() })
              .optional()
              .openapi({
                description:
                  "One more round from this post: who answers (default: every agent). On a concluded topic it reopens it and the synthesis is rewritten as a new version; at the last round it adds a round instead of going to the synthesis. At most 10 rounds.",
              }),
            replyTo: z.uuid().optional().openapi({ description: "The post this one answers." }),
          }),
        ),
      },
      responses: { 201: json(Post, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, topicId } = c.req.valid("param");
      const input = c.req.valid("json");
      const post = await postInForumAsPerson(forum(), c.get("user").id, orgId, topicId, input.body, {
        requestRound: input.requestRound ? { agentIds: input.requestRound.agentIds ?? null } : null,
        replyTo: input.replyTo ?? null,
      });
      return c.json(post, 201);
    },
  );

  const action = (path: string, summary: string, run: typeof concludeForumTopic) =>
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/forum/topics/{topicId}/${path}`,
        tags,
        security,
        summary,
        request: { params: TopicParams },
        responses: { 200: json(Detail), ...errors },
      }),
      async (c) => {
        const { orgId, topicId } = c.req.valid("param");
        return c.json(await run(forum(), c.get("user").id, orgId, topicId), 200);
      },
    );
  action("conclude", "Conclude now: no more turns; the synthesis is written next", concludeForumTopic);
  action("cancel", "Cancel: stop with no synthesis", cancelForumTopic);
  action("pass", 'Pass your seated turn ("Passar a vez"): the round goes on without you', passForumTurn);
  action("resume", "Resume a stalled topic: the stopped turn starts again", resumeForumTopic);

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/forum/topics/{topicId}/participants",
      tags,
      security,
      summary: "Add or remove agents and people, sit people at the table (agents must answer the topic's person)",
      request: {
        params: TopicParams,
        body: body(
          z.object({
            addAgentIds: z.array(z.uuid()).max(8).optional(),
            removeAgentIds: z.array(z.uuid()).max(8).optional(),
            addUserIds: z.array(z.string()).max(50).optional(),
            removeUserIds: z.array(z.string()).max(50).optional(),
            seatUserIds: z.array(z.string()).max(8).optional(),
            unseatUserIds: z.array(z.string()).max(8).optional(),
          }),
        ),
      },
      responses: { 200: json(Detail), ...errors },
    }),
    async (c) => {
      const { orgId, topicId } = c.req.valid("param");
      return c.json(await setForumParticipants(forum(), c.get("user").id, orgId, topicId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/forum/topics/{topicId}/issues",
      tags,
      security,
      summary:
        "Create the synthesis' suggested issues a person approved (sub-issues of the origin issue, when there is one)",
      request: {
        params: TopicParams,
        body: body(z.object({ items: z.array(SuggestedIssue).min(1).max(10) })),
      },
      responses: {
        200: json(
          z.object({
            numbers: z.array(z.number()),
            issues: z.array(z.object({ id: z.uuid(), number: z.number(), title: z.string() })),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, topicId } = c.req.valid("param");
      return c.json(await createForumIssues(forum(), c.get("user").id, orgId, topicId, c.req.valid("json").items), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/forum/suggestions/{messageId}/accept",
      tags,
      security,
      summary: "Open the topic an agent suggested (the card's message): it is yours; fields can be adjusted",
      request: {
        params: SuggestionParams,
        body: body(
          z.object({
            title: z.string().min(1).max(200).optional(),
            goal: z.string().min(1).max(5000).optional(),
            ...TableInput,
            agentIds: TableInput.agentIds.optional(),
          }),
        ),
      },
      responses: { 201: json(z.object({ topic: Detail, suggestion: Suggestion }), "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const { deadline, ...input } = c.req.valid("json");
      const result = await acceptForumSuggestion(forum(), c.get("user").id, orgId, messageId, {
        ...input,
        ...(deadline ? { deadline: new Date(deadline) } : {}),
      });
      return c.json(result, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/forum/suggestions/{messageId}/dismiss",
      tags,
      security,
      summary: "Dismiss an agent's forum suggestion (the card stays, marked dismissed)",
      request: { params: SuggestionParams },
      responses: { 200: json(z.object({ suggestion: Suggestion })), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await dismissForumSuggestion(forum(), c.get("user").id, orgId, messageId), 200);
    },
  );

  return app;
}
