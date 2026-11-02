import { agentWorkForViewer, redoAgentAction, undoAgentAction, undoMessageActions } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";
import { AgentAction } from "./schemas";

const tags = ["Chat"];

const ForYouItem = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("action"), at: z.string(), channelId: z.uuid(), action: AgentAction }),
    z.object({
      type: z.literal("file"),
      at: z.string(),
      file: z.object({
        id: z.uuid(),
        kind: z.enum(["document", "table", "diff", "html", "diagram", "file", "block", "poll", "choices"]),
        title: z.string(),
        channelId: z.string().nullable(),
        threadId: z.string().nullable(),
      }),
    }),
    z.object({
      type: z.literal("approval"),
      at: z.string(),
      approval: z.object({
        id: z.uuid(),
        title: z.string(),
        status: z.enum(["pending", "approved", "refused", "expired", "canceled"]),
        channelId: z.string(),
        threadId: z.string().nullable().openapi({ description: "Where its card is; null: the main timeline." }),
        waitingOnYou: z.boolean().openapi({ description: "Pending, and the viewer may decide it." }),
      }),
    }),
  ])
  .openapi("AgentForYouItem");

/**
 * Act with undo (ADR 0037 round 2): the receipts under an agent's reply.
 * The person the agent worked for, admins and the agent's owner may undo
 * (or redo) while `undoableUntil` has not passed. Conflicts (409):
 * `action.changed_since` (someone changed it after the agent),
 * `action.expired`, `action.already_undone`, `action.not_undone`.
 * Everyone in the channel hears `message.actions`.
 */
export function actionRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const undoDeps = { db, pubsub: deps.adapters.pubsub };
  const ActionParams = OrgParams.extend({ actionId: z.uuid() });

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/actions/{actionId}/undo",
      tags,
      security,
      summary: "Undo a change an agent made (Desfazer)",
      request: { params: ActionParams, body: body(z.object({})) },
      responses: { 200: json(AgentAction), ...errors },
    }),
    async (c) => {
      const { orgId, actionId } = c.req.valid("param");
      return c.json(await undoAgentAction(undoDeps, c.get("user").id, orgId, actionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/actions/{actionId}/redo",
      tags,
      security,
      summary: "Redo a change that was undone (Refazer)",
      request: { params: ActionParams, body: body(z.object({})) },
      responses: { 200: json(AgentAction), ...errors },
    }),
    async (c) => {
      const { orgId, actionId } = c.req.valid("param");
      return c.json(await redoAgentAction(undoDeps, c.get("user").id, orgId, actionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/actions/undo",
      tags,
      security,
      summary: "Undo every change of an agent's reply still undoable, newest first (Desfazer tudo)",
      request: { params: OrgParams.extend({ messageId: z.uuid() }), body: body(z.object({})) },
      responses: {
        200: json(
          z.object({
            actions: z.array(AgentAction).openapi({ description: "The message's receipts now." }),
            failed: z
              .array(z.object({ id: z.uuid(), code: z.string(), message: z.string() }))
              .openapi({ description: "Changes that could not be undone (e.g. `action.changed_since`)." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await undoMessageActions(undoDeps, c.get("user").id, orgId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/for-you",
      tags,
      security,
      summary: "What an agent did for the viewer: their receipts, its files in shared conversations, approvals",
      description:
        "Newest first. Receipts of runs the viewer asked for (not undone, memory left out), files the agent made " +
        "in conversations the viewer shares with it, approvals the viewer decided or may decide now.",
      request: {
        params: OrgParams.extend({ agentId: z.uuid() }),
        query: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
      },
      responses: {
        200: json(
          z.object({
            items: z.array(ForYouItem),
            monthCount: z.number().openapi({ description: "Items since the first day of this month (UTC)." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      return c.json(await agentWorkForViewer(db, c.get("user").id, orgId, agentId, { limit }), 200);
    },
  );

  return app;
}
