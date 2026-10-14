import { archiveChannel, removeChannelMember } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, noContent, OrgParams, requireSession, security } from "./context";

const tags = ["Channels"];
const ChannelParams = OrgParams.extend({ channelId: z.uuid() });

/** Channel management beyond chat (`chat.ts`): membership removal; open subscriptions are revoked at once. */
export function channelRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const opts = { pubsub: adapters.pubsub };

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/leave",
      tags,
      security,
      summary: "Leave a channel",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const userId = c.get("user").id;
      await removeChannelMember(db, userId, orgId, channelId, { userId }, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}/members/people/{userId}",
      tags,
      security,
      summary: "Remove a person from a channel (creator or admin)",
      request: { params: ChannelParams.extend({ userId: z.string() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId, userId } = c.req.valid("param");
      await removeChannelMember(db, c.get("user").id, orgId, channelId, { userId }, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}/members/agents/{agentId}",
      tags,
      security,
      summary: "Remove an agent from a channel (creator or admin)",
      request: { params: ChannelParams.extend({ agentId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId, agentId } = c.req.valid("param");
      await removeChannelMember(db, c.get("user").id, orgId, channelId, { agentId }, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}",
      tags,
      security,
      summary: "Archive a channel (creator or admin)",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await archiveChannel(db, c.get("user").id, orgId, channelId, opts);
      return c.body(null, 204);
    },
  );

  return app;
}
