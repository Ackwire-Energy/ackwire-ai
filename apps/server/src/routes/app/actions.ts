import { redoAgentAction, undoAgentAction, undoMessageActions } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";
import { AgentAction } from "./schemas";

const tags = ["Chat"];

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

  return app;
}
