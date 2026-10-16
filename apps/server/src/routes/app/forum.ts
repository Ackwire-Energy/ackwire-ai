import {
  cancelForumTopic,
  canViewCost,
  concludeForumTopic,
  createForumIssues,
  createForumTopic,
  type ForumDeps,
  getForumTopic,
  listForumTopics,
  postInForumAsPerson,
  setForumParticipants,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Forum"];
const Status = z.enum(["open", "done", "canceled"]);
const Actor = z.object({ type: z.enum(["person", "agent"]), id: z.string() });
const SuggestedIssue = z.object({ title: z.string().min(1).max(300), description: z.string().max(5000) });
const Topic = z
  .object({
    id: z.uuid(),
    title: z.string(),
    goal: z.string(),
    status: Status,
    round: z.number().openapi({ description: "The round in progress (or the last one when finished), from 1." }),
    rounds: z.number(),
    agentIds: z.array(z.uuid()),
    userIds: z.array(z.string()),
    createdBy: Actor,
    originChannelId: z.uuid().nullable(),
    channelId: z.uuid().openapi({ description: "The topic's channel: subscribe to it for the agents' live runs." }),
    createdAt: z.string(),
    lastActivityAt: z.string(),
    budgetUsedPercent: z
      .number()
      .nullable()
      .openapi({ description: "Share of the discussion's spend cap used, in %; null without a cap." }),
    activeAgentIds: z.array(z.uuid()),
    synthesis: z
      .object({
        artifactId: z.uuid(),
        version: z.number(),
        suggestedIssues: z.array(SuggestedIssue),
        deleted: z.boolean().optional().openapi({ description: "The synthesis file was deleted." }),
      })
      .nullable(),
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
    meta: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string(),
  })
  .openapi("ForumPost");
const Detail = Topic.extend({ posts: z.array(Post) }).openapi("ForumTopicDetail");
const TopicParams = OrgParams.extend({ topicId: z.uuid() });

/**
 * The forum (D33): topics where agents discuss in rounds and end with a
 * synthesis. Everyone in the organization reads it; people post at any time
 * (their post leads the next round) and can conclude or cancel.
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
            agentIds: z.array(z.uuid()).min(1).max(8),
            userIds: z.array(z.string()).max(50).optional(),
            rounds: z.number().int().min(1).max(10).optional(),
            budgetUsd: z.number().positive().max(1000).nullable().optional().openapi({
              description:
                "Admins only: spend cap for the whole discussion (default 0.50; null = no cap). Ignored for members.",
            }),
            deadline: z.iso.datetime().optional(),
            ownerAgentId: z
              .uuid()
              .optional()
              .openapi({ description: "Writes the synthesis (default: the first agent)." }),
          }),
        ),
      },
      responses: { 201: json(Detail, "Created"), ...errors },
    }),
    async (c) => {
      const { budgetUsd, ...input } = c.req.valid("json");
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      // Members never set money: their discussions get the default cap.
      const seesCost = await canViewCost(db, actor, orgId);
      const topic = await createForumTopic(forum(), { type: "person", userId: actor }, orgId, {
        ...input,
        ...(seesCost ? { budgetUsd } : {}),
        deadline: input.deadline ? new Date(input.deadline) : null,
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
      summary: "A topic with its posts (one per agent per round; people's posts in between)",
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
      summary: "A person posts: it leads the next round (the current turn finishes first)",
      request: { params: TopicParams, body: body(z.object({ body: z.string().min(1).max(20_000) })) },
      responses: { 201: json(Post, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, topicId } = c.req.valid("param");
      const post = await postInForumAsPerson(forum(), c.get("user").id, orgId, topicId, c.req.valid("json").body);
      return c.json(post, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/forum/topics/{topicId}/conclude",
      tags,
      security,
      summary: "Conclude now: no more turns; the synthesis is written next",
      request: { params: TopicParams },
      responses: { 200: json(Detail), ...errors },
    }),
    async (c) => {
      const { orgId, topicId } = c.req.valid("param");
      return c.json(await concludeForumTopic(forum(), c.get("user").id, orgId, topicId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/forum/topics/{topicId}/cancel",
      tags,
      security,
      summary: "Cancel: stop with no synthesis",
      request: { params: TopicParams },
      responses: { 200: json(Detail), ...errors },
    }),
    async (c) => {
      const { orgId, topicId } = c.req.valid("param");
      return c.json(await cancelForumTopic(forum(), c.get("user").id, orgId, topicId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/forum/topics/{topicId}/participants",
      tags,
      security,
      summary: "Add or remove agents and people (agents must answer the topic's person)",
      request: {
        params: TopicParams,
        body: body(
          z.object({
            addAgentIds: z.array(z.uuid()).max(8).optional(),
            removeAgentIds: z.array(z.uuid()).max(8).optional(),
            addUserIds: z.array(z.string()).max(50).optional(),
            removeUserIds: z.array(z.string()).max(50).optional(),
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
      summary: "Create the synthesis' suggested issues a person approved",
      request: {
        params: TopicParams,
        body: body(z.object({ items: z.array(SuggestedIssue).min(1).max(10) })),
      },
      responses: { 200: json(z.object({ numbers: z.array(z.number()) })), ...errors },
    }),
    async (c) => {
      const { orgId, topicId } = c.req.valid("param");
      return c.json(await createForumIssues(forum(), c.get("user").id, orgId, topicId, c.req.valid("json").items), 200);
    },
  );

  return app;
}
