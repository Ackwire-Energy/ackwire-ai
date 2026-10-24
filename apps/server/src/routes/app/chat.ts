import {
  activeRunsIn,
  addChannelMember,
  answerNow,
  createChannel,
  joinChannel,
  listChannelMembers,
  listChannels,
  listMessages,
  listWorkingRuns,
  postPersonMessage,
  requireChannelAccess,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  aiStatusDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { Channel, Message } from "./schemas";

const tags = ["Chat"];
const ChannelParams = OrgParams.extend({ channelId: z.uuid() });

/** Channels and messages. Real-time updates arrive over the WebSocket (`/api/ws`). */
export function chatRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels",
      tags,
      security,
      summary: "Public channels and the private ones you belong to, with your unread count and the last message",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ channels: z.array(Channel) })), ...errors },
    }),
    async (c) => {
      const rows = await listChannels(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        {
          channels: rows.map((r) => ({
            id: r.id,
            name: r.name,
            topic: r.topic,
            visibility: r.visibility,
            isMember: r.isMember,
            createdByUserId: r.createdByUserId,
            createdAt: r.createdAt.toISOString(),
            unreadCount: r.unreadCount,
            lastMessage: r.lastMessage ? { ...r.lastMessage, createdAt: r.lastMessage.createdAt.toISOString() } : null,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/active-runs",
      tags,
      security,
      summary: "Agents working now in the conversations you are in (any member)",
      description:
        "Agent runs queued, running or waiting (approval or an answer) in the channels and DMs you are a member of, newest first (at most 100). Never another person's DM or a private channel you're not in. No cost.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            runs: z.array(
              z
                .object({
                  runId: z.uuid(),
                  agentId: z.uuid(),
                  channelId: z.uuid(),
                  channelKind: z.enum(["channel", "dm"]),
                  channelName: z.string().nullable().openapi({ description: "Null for a DM." }),
                  threadId: z.uuid().nullable().openapi({ description: "Null: the main timeline (DMs are flat)." }),
                  status: z.enum(["queued", "running", "waiting_approval", "waiting_input"]),
                  startedAt: z.string().nullable(),
                  createdAt: z.string(),
                  label: z
                    .string()
                    .nullable()
                    .openapi({ description: "What it works on: the thread's title, else its first message (≤ 80)." }),
                  pendingMessageIds: z.array(z.uuid()).openapi({
                    description: "Messages sent to it while it works that it hasn't read yet.",
                  }),
                  background: z.boolean().openapi({
                    description: "A routine's work in the background: people's messages never go to it.",
                  }),
                })
                .openapi("WorkingRun"),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const runs = await listWorkingRuns(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ runs }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels",
      tags,
      security,
      summary: "Create a channel (you join it)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            name: z.string().min(1).max(80),
            topic: z.string().max(500).optional(),
            visibility: z.enum(["public", "private"]).optional(),
          }),
        ),
      },
      responses: { 201: json(Channel, "Created"), ...errors },
    }),
    async (c) => {
      const r = await createChannel(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.json(
        {
          id: r.id,
          name: r.name,
          topic: r.topic,
          visibility: r.visibility,
          isMember: true,
          createdByUserId: r.createdByUserId,
          createdAt: r.createdAt.toISOString(),
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/join",
      tags,
      security,
      summary: "Join a public channel",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await joinChannel(db, c.get("user").id, orgId, channelId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/members",
      tags,
      security,
      summary: "People and agents in a channel",
      request: { params: ChannelParams },
      responses: {
        200: json(z.object({ members: z.array(z.object({ type: z.enum(["person", "agent"]), id: z.string() })) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      return c.json({ members: await listChannelMembers(db, c.get("user").id, orgId, channelId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/members",
      tags,
      security,
      summary: "Add a person or an agent to a channel (creator or admin; an agent also needs an admin or its owner)",
      request: {
        params: ChannelParams,
        body: body(
          z.union([
            z.object({ userId: z.string() }),
            z.object({
              agentId: z.uuid(),
              autoReply: z
                .boolean()
                .optional()
                .openapi({ description: "Answers here without a mention (router). Default true." }),
            }),
          ]),
        ),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await addChannelMember(db, c.get("user").id, orgId, channelId, c.req.valid("json"), { pubsub: adapters.pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/active-runs",
      tags,
      security,
      summary: "Agent runs still in progress here (call on load and reconnect to drop stale live rows)",
      request: { params: ChannelParams },
      responses: {
        200: json(
          z.object({
            runs: z.array(
              z.object({
                runId: z.uuid(),
                agentId: z.uuid(),
                channelId: z.uuid(),
                status: z.enum(["queued", "running", "waiting_approval", "waiting_input"]),
                threadId: z.uuid().nullable(),
                triggerMessageId: z.uuid(),
                startedAt: z.string().nullable(),
                heartbeatAt: z.string().nullable().openapi({ description: "Last sign of life of its worker." }),
                createdAt: z.string(),
                pendingMessageIds: z.array(z.uuid()).openapi({
                  description:
                    "Messages sent while it works that it hasn't read yet. A message whose `meta.steeredRunIds` names a run that is not here, or is here without it in this list, was read (or handed on: `agent.run.redispatched`).",
                }),
                background: z.boolean().openapi({
                  description: "A routine's work in the background: people's messages never go to it.",
                }),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await requireChannelAccess(db, c.get("user").id, orgId, channelId);
      const runs = await activeRunsIn(db, orgId, channelId);
      return c.json(
        {
          runs: runs.map((r) => ({
            ...r,
            status: r.status as "queued" | "running" | "waiting_approval" | "waiting_input",
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/messages",
      tags,
      security,
      summary: "Messages of a channel or of one thread",
      request: {
        params: ChannelParams,
        query: z.object({
          threadId: z.uuid().optional(),
          before: z.iso
            .datetime()
            .optional()
            .openapi({ description: "Page backwards from this time (top-level messages)." }),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          include: z
            .string()
            .optional()
            .openapi({ description: "`replies`: add reply count, last activity and the latest replies per thread." }),
        }),
      },
      responses: { 200: json(z.object({ messages: z.array(Message) })), ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const q = c.req.valid("query");
      const messages = await listMessages(db, c.get("user").id, orgId, channelId, {
        threadId: q.threadId,
        before: q.before ? new Date(q.before) : undefined,
        limit: q.limit,
        includeReplies: q.include?.split(",").includes("replies") ?? false,
      });
      return c.json({ messages }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/messages",
      tags,
      security,
      summary: "Post a message",
      description:
        "@mentioning an agent that is a member of the channel starts an agent run; its reply streams over the WebSocket.",
      request: {
        params: ChannelParams,
        body: body(
          z.object({
            body: z
              .string()
              .max(40_000)
              .openapi({ description: "Markdown. May be empty only when `attachments` has files." }),
            threadId: z.uuid().nullable().optional(),
            replyTo: z.uuid().nullable().optional().openapi({
              description:
                "Quote reply: a message of this channel. Stored as `meta.replyTo` ({ messageId, threadId, author, authorName, excerpt }).",
            }),
            attachments: z.array(z.uuid()).max(10).optional().openapi({
              description:
                "Files (artifact ids) you uploaded or files of this channel. Stored as `meta.artifacts` ({ id, version, title }).",
            }),
            openThread: z.boolean().optional().openapi({
              description:
                'Sent from the thread panel ("Responder"), with `threadId`: the thread gets `openedByReplyAt`, so from this reply on the channel shows one line instead of its replies.',
            }),
            steer: z.literal("now").optional().openapi({
              description:
                "Sent while an agent works here (it goes into its task): stop its current model call and read this message now. Without it, the agent reads it at its next step.",
            }),
            clientId: z
              .string()
              .max(64)
              .optional()
              .openapi({ description: "Your id for the optimistic copy; echoed back on the message and its event." }),
          }),
        ),
      },
      responses: { 201: json(Message, "Created"), 429: errorResponse("Too many messages"), ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const user = c.get("user");
      const limit = await adapters.rateLimiter.consume(`post:${user.id}`, { limit: 30, windowMs: 10_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Slow down");
      const started = performance.now();
      const message = await postPersonMessage(
        { db, pubsub: adapters.pubsub, judge: deps.extras?.context?.judge, talker: deps.extras?.talker },
        user.id,
        orgId,
        channelId,
        c.req.valid("json"),
      );
      // Wake the workers now (router, runs, indexing) instead of waiting for the poll.
      deps.wakeWorkers?.();
      // post → `message.created` published (the commit and the event happen inside postPersonMessage).
      c.header("server-timing", `created;dur=${(performance.now() - started).toFixed(1)}`);
      return c.json(message, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/answer-now",
      tags,
      security,
      summary: "Once an AI is connected, the agent answers what it couldn't (Responder agora)",
      description:
        "The id is a no-AI card (`meta.noAi`: its agent's failed run in that conversation starts again on the person's message) or the person's message (its failed `no_ai` runs start again, else it is routed again). Who asked, the agent's owner or an admin. 409 `ai.still_missing` while there's still no AI; 409 `run.not_restartable` when that run had already done something (a tool, a reply, an approval), so starting over would repeat it. Pressed again, it returns the runs that answer it.",
      request: { params: OrgParams.extend({ messageId: z.uuid() }) },
      responses: {
        200: json(z.object({ runs: z.array(z.object({ agentId: z.uuid(), runId: z.uuid() })) })),
        429: errorResponse("Too many requests"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const user = c.get("user");
      // It sends the message again, in effect: the same limit as posting.
      const limit = await adapters.rateLimiter.consume(`post:${user.id}`, { limit: 30, windowMs: 10_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Slow down");
      const result = await answerNow(
        { ...aiStatusDeps(deps), db, pubsub: adapters.pubsub, router: deps.extras?.router ?? null },
        user.id,
        orgId,
        messageId,
      );
      deps.wakeWorkers?.();
      return c.json(result, 200);
    },
  );

  return app;
}
