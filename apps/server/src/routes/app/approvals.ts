import {
  cancelAheadApproval,
  decideApproval,
  decideApprovals,
  getApproval,
  listApprovalRules,
  listApprovals,
  memoryJudging,
  removeApprovalRule,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Approvals"];

/** Where an approval asked while nobody watched comes from (ADR 0053 §8): a routine, or unattended work. */
export const ApprovalOrigin = z.union([
  z.object({ kind: z.literal("routine"), routineId: z.string(), routineName: z.string() }),
  z.object({ kind: z.literal("unattended") }),
]);

/** The email a mail approval writes, as its card shows it. */
export const ApprovalEmail = z
  .object({
    verb: z.enum(["draft", "send", "reply", "forward"]),
    mailbox: z.string().openapi({ example: "support@acme.com" }),
    provider: z.string().nullable().openapi({ example: "iCloud" }),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    subject: z.string(),
    body: z.string().openapi({ description: "The text, cut after 1500 characters." }),
    original: z
      .object({ subject: z.string(), from: z.string().nullable() })
      .nullable()
      .openapi({ description: "The message it answers or forwards." }),
  })
  .openapi("ApprovalEmail");

export const Approval = z
  .object({
    id: z.uuid(),
    runId: z.uuid().nullable().openapi({ description: "Null when a mission's executor asked (`missionId`)." }),
    missionId: z.uuid().nullable(),
    agentId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable().openapi({ description: "Where its card is; null: the channel's main timeline." }),
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
    email: ApprovalEmail.nullable().openapi({
      description: "The email itself, for mail drafts and sends (From, To, Subject, text); null otherwise.",
    }),
    why: z
      .string()
      .nullable()
      .openapi({ description: "The agent's required reason: what it found and why this action." }),
    origin: ApprovalOrigin.nullable().openapi({
      description: "Asked while nobody was watching: by a routine, or by unattended work.",
    }),
    issue: z.object({ id: z.uuid(), number: z.number().int(), title: z.string() }).nullable(),
    trail: z
      .array(z.object({ text: z.string(), at: z.string() }))
      .optional()
      .openapi({ description: "One approval only: what the agent said at each turn before asking." }),
    approveAlways: z
      .object({ tool: z.string(), actions: z.array(z.string()) })
      .nullable()
      .openapi({
        description:
          '"Aprovar sempre" is offered: approving with `always` lets the agent run this server tool (each of these wrapped actions) without asking again, with any values. Null: not offered.',
        example: { tool: "COMPOSIO_MULTI_EXECUTE_TOOL", actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"] },
      }),
    runAt: z.string().nullable().openapi({
      description:
        "Approved ahead (`schedule_action`): when the routine's run does it by itself, without asking again. Null: it runs once approved.",
    }),
    routineId: z.uuid().nullable().openapi({ description: "The routine whose run at `runAt` it is for." }),
    canCancel: z
      .boolean()
      .openapi({ description: "Approved ahead and not run yet, and you may withdraw it (`…/cancel`)." }),
    approvers: z
      .object({
        label: z.string().openapi({ description: "Who decides, in words.", example: "Diretoria" }),
        requestedByUserId: z.string().nullable().openapi({ description: "Whose request it was." }),
        requesterDecides: z
          .boolean()
          .openapi({ description: "The requester approves by role, so they may decide it too." }),
      })
      .nullable()
      .openapi({
        description:
          "Asked with `request_approval` (ADR 0126): who decides instead of the agent's owner and admins. Null: any other approval.",
      }),
  })
  .openapi("Approval");

export const ApprovalRule = z
  .object({
    id: z.uuid(),
    connectionId: z
      .uuid()
      .nullable()
      .openapi({ description: "Null: a command on the agent's computer (`tool` is `command`)." }),
    server: z
      .string()
      .nullable()
      .openapi({ description: "The connection's name; null for a command.", example: "Composio" }),
    tool: z.string().openapi({ description: "The server's own tool name.", example: "COMPOSIO_MULTI_EXECUTE_TOOL" }),
    toolLabel: z.string().openapi({ description: "How the workspace labelled that tool." }),
    action: z.string().openapi({
      description: "The wrapped action (empty: the tool itself).",
      example: "GITHUB_CREATE_AN_ISSUE_COMMENT",
    }),
    createdByUserId: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("ApprovalRule");

const ApprovalParams = OrgParams.extend({ approvalId: z.uuid() });
const AgentParams = OrgParams.extend({ agentId: z.uuid() });
const Decision = z.object({ reason: z.string().max(1000).optional() });
const Approve = Decision.extend({
  always: z.boolean().optional().openapi({
    description:
      "Also approve this kind for good (only where `approveAlways` is set, else 409 `approval.always_unavailable`).",
  }),
});

/**
 * Sensitive actions agents asked for (ADR 0015). Decisions resume the run; events
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
          messageId: z.uuid().optional().openapi({ description: "The requests on one approval card." }),
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

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/approvals/decide",
      tags,
      security,
      summary: 'Decide several at once (a card\'s "Aprovar tudo"): exactly these ids, the ones you may decide',
      request: {
        params: OrgParams,
        body: body(
          z.object({
            ids: z.array(z.uuid()).min(1).max(50),
            decision: z.enum(["approve", "refuse"]),
            reason: z.string().max(1000).optional(),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            approvals: z.array(Approval),
            skipped: z
              .array(z.uuid())
              .openapi({ description: "Not decided: already decided, not found, or not yours to decide." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const result = await decideApprovals(
        {
          db,
          pubsub: adapters.pubsub,
          memory: deps.extras?.context ? memoryJudging(deps.extras.context) : undefined,
        },
        c.get("user").id,
        orgId,
        c.req.valid("json"),
      );
      deps.wakeWorkers?.();
      return c.json(result, 200);
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
        request: { params: ApprovalParams, body: body(decision === "approve" ? Approve : Decision) },
        responses: { 200: json(Approval), ...errors },
      }),
      async (c) => {
        const { orgId, approvalId } = c.req.valid("param");
        const input: { reason?: string; always?: boolean } = c.req.valid("json");
        const view = await decideApproval(
          {
            db,
            pubsub: adapters.pubsub,
            memory: deps.extras?.context ? memoryJudging(deps.extras.context) : undefined,
          },
          c.get("user").id,
          orgId,
          approvalId,
          { decision, reason: input.reason, always: decision === "approve" && input.always === true },
        );
        deps.wakeWorkers?.();
        return c.json(view, 200);
      },
    );
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/approvals/{approvalId}/cancel",
      tags,
      security,
      summary:
        "Withdraw an action approved ahead before its time (or its request, still waiting): its routine's run won't do it",
      description:
        "Of those who see it (as on the approvals list), who may decide it and who manages its routine: 404 for anyone else. 409 `approval.not_ahead` for an action that runs once approved, `approval.not_cancelable` once it ran or ended.",
      request: { params: ApprovalParams },
      responses: { 200: json(Approval), ...errors },
    }),
    async (c) => {
      const { orgId, approvalId } = c.req.valid("param");
      const view = await cancelAheadApproval({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, approvalId);
      deps.wakeWorkers?.();
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/approval-rules",
      tags,
      security,
      summary: 'What the agent runs without asking ("Aprovar sempre"), oldest first',
      request: { params: AgentParams },
      responses: { 200: json(z.object({ rules: z.array(ApprovalRule) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ rules: await listApprovalRules(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agents/{agentId}/approval-rules/{ruleId}",
      tags,
      security,
      summary: "The agent asks again for this kind (admins and the agent's owner)",
      request: { params: AgentParams.extend({ ruleId: z.uuid() }) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, agentId, ruleId } = c.req.valid("param");
      await removeApprovalRule(db, c.get("user").id, orgId, agentId, ruleId);
      return c.body(null, 204);
    },
  );

  return app;
}
