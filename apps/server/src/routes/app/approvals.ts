import { decideApproval, getApproval, listApprovals, memoryJudging } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Approvals"];

export const Approval = z
  .object({
    id: z.uuid(),
    runId: z.uuid().nullable().openapi({ description: "Null when a mission's executor asked (`missionId`)." }),
    missionId: z.uuid().nullable(),
    agentId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid(),
    messageId: z.uuid().nullable().openapi({ description: "The approval card in the chat." }),
    tool: z.string(),
    scope: z.string(),
    title: z.string().openapi({ example: "Merge PR #42 into main" }),
    detail: z.string(),
    params: z.record(z.string(), z.unknown()).openapi({ description: "Exactly what will run if approved." }),
    status: z.enum(["pending", "approved", "refused", "expired", "canceled"]),
    expiresAt: z.string(),
    createdAt: z.string(),
    decidedByUserId: z.string().nullable(),
    decidedAt: z.string().nullable(),
    reason: z.string().nullable(),
    canDecide: z.boolean().openapi({ description: "You are the agent's owner or an admin, and it is pending." }),
    ownerUserId: z.string().nullable().openapi({ description: "The agent's owner (they and admins may decide)." }),
    executedAt: z.string().nullable().openapi({ description: "When the approved action ran." }),
    result: z
      .object({ ok: z.boolean(), text: z.string() })
      .nullable()
      .openapi({ description: "What the action returned once it ran (raw, short)." }),
    connector: z.string().nullable().openapi({ example: "github" }),
    connectorAccount: z.string().nullable().openapi({ example: "acme" }),
    why: z.string().nullable().openapi({ description: "What the agent said right before asking." }),
    issue: z.object({ id: z.uuid(), number: z.number().int(), title: z.string() }).nullable(),
    trail: z
      .array(z.object({ text: z.string(), at: z.string() }))
      .optional()
      .openapi({ description: "One approval only: what the agent said at each turn before asking." }),
  })
  .openapi("Approval");

const ApprovalParams = OrgParams.extend({ approvalId: z.uuid() });
const Decision = z.object({ reason: z.string().max(1000).optional() });

/**
 * Sensitive actions agents asked for (D4). Decisions resume the run; events
 * `approval.created` / `approval.decided` go to the channel and to approvers
 * over the WebSocket.
 */
export function approvalRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/approvals",
      tags,
      security,
      summary: "Approvals you can see (admins: all; others: their agents' and their channels')",
      request: {
        params: OrgParams,
        query: z.object({
          status: z.enum(["pending", "decided"]).optional(),
          agentId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: { 200: json(z.object({ approvals: z.array(Approval) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ approvals: await listApprovals(db, c.get("user").id, orgId, c.req.valid("query")) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/approvals/{approvalId}",
      tags,
      security,
      summary: "One approval",
      request: { params: ApprovalParams },
      responses: { 200: json(Approval), ...errors },
    }),
    async (c) => {
      const { orgId, approvalId } = c.req.valid("param");
      return c.json(await getApproval(db, c.get("user").id, orgId, approvalId), 200);
    },
  );

  for (const decision of ["approve", "refuse"] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/approvals/{approvalId}/${decision}`,
        tags,
        security,
        summary:
          decision === "approve" ? "Approve: the run executes exactly this action" : "Refuse: the agent is told why",
        request: { params: ApprovalParams, body: body(Decision) },
        responses: { 200: json(Approval), ...errors },
      }),
      async (c) => {
        const { orgId, approvalId } = c.req.valid("param");
        const view = await decideApproval(
          {
            db,
            pubsub: adapters.pubsub,
            memory: deps.extras?.context ? memoryJudging(deps.extras.context, orgId) : undefined,
          },
          c.get("user").id,
          orgId,
          approvalId,
          {
            decision,
            reason: c.req.valid("json").reason,
          },
        );
        deps.wakeWorkers?.();
        return c.json(view, 200);
      },
    );
  }

  return app;
}
