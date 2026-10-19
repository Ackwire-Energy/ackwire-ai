import {
  cancelHandoff,
  claimHandoff,
  finishHandoff,
  getHandoff,
  type HandoffDeps,
  handoffView,
  openHandoffOf,
  requireBrowserAccess,
  startTakeover,
  stopAgentBrowser,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Agent browser"];

const BrowserHandoff = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    runId: z.uuid().nullable(),
    machineId: z.uuid(),
    kind: z.enum(["ask", "takeover"]),
    instructions: z.string(),
    status: z.enum(["pending", "active", "done", "failed", "expired", "cancelled"]),
    requestedForUserId: z.string().nullable(),
    controllerUserId: z.string().nullable(),
    note: z.string().nullable(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
  })
  .openapi("BrowserHandoff");

const HandoffParams = OrgParams.extend({ handoffId: z.uuid() });
const AgentParams = OrgParams.extend({ agentId: z.uuid() });

/**
 * A person's turn in an agent's browser (ADR 0040 §6). The agent asks
 * (`browser_ask_person`: a card, "Waiting for you", a push); the person
 * takes control on the live view, then presses Done or Couldn't and the
 * agent goes on. Someone watching can also take over and hand back. The
 * live view itself is on `/api/ws` (`browser.watch`).
 */
export function browserRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const handoffDeps: HandoffDeps = deps.extras?.browserLive?.handoffDeps ?? { db, pubsub: adapters.pubsub };
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}",
      tags,
      security,
      summary: "A person's turn in an agent's browser",
      request: { params: HandoffParams },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      return c.json(await getHandoff(db, c.get("user").id, orgId, handoffId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/browser/handoff",
      tags,
      security,
      summary: "The open handoff of an agent's browser (who is in control), if any",
      request: { params: AgentParams },
      responses: { 200: json(z.object({ handoff: BrowserHandoff.nullable() })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await requireBrowserAccess(db, c.get("user").id, orgId, agentId);
      const open = await openHandoffOf(db, orgId, agentId);
      return c.json({ handoff: open ? handoffView(open) : null }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}/control",
      tags,
      security,
      summary: "Take control of an agent's request (one person at a time)",
      request: { params: HandoffParams },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      return c.json(await claimHandoff(handoffDeps, c.get("user").id, orgId, handoffId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}/done",
      tags,
      security,
      summary: "Done (or hand back a take over): the agent reads the page again and goes on",
      request: { params: HandoffParams },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      return c.json(await finishHandoff(handoffDeps, c.get("user").id, orgId, handoffId, { result: "done" }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}/failed",
      tags,
      security,
      summary: "Couldn't do it, with an optional note the agent reads",
      request: { params: HandoffParams, body: body(z.object({ note: z.string().max(1000).optional() })) },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      const { note } = c.req.valid("json");
      return c.json(
        await finishHandoff(handoffDeps, c.get("user").id, orgId, handoffId, { result: "failed", note }),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}/cancel",
      tags,
      security,
      summary: "Cancel an agent's request; it goes on without it",
      request: { params: HandoffParams },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      return c.json(await cancelHandoff(handoffDeps, c.get("user").id, orgId, handoffId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/browser/takeover",
      tags,
      security,
      summary: "Take over an agent's browser while watching; it waits until handed back",
      request: { params: AgentParams },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await startTakeover(handoffDeps, c.get("user").id, orgId, agentId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/browser/stop",
      tags,
      security,
      summary: "Close the agent's browser now (its logins stay); its next browser call opens a fresh one",
      request: { params: AgentParams },
      responses: { 204: { description: "Closed" }, ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await stopAgentBrowser(db, deps.extras?.sandbox?.machines?.hub, c.get("user").id, orgId, agentId);
      return c.body(null, 204);
    },
  );

  return app;
}
