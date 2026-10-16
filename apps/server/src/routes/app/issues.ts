import {
  askAgentToImplement,
  commentIssue,
  createIssue,
  getIssue,
  type IssueDeps,
  issueFromMessage,
  listIssueActivity,
  listIssues,
  setCriterion,
  updateIssue,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Issues"];
const Actor = z.object({ type: z.enum(["person", "agent"]), id: z.string() });
const Status = z.enum(["todo", "in_progress", "in_review", "done", "canceled"]);
const Priority = z.enum(["low", "normal", "high"]);
const DueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

const Issue = z
  .object({
    id: z.uuid(),
    number: z.number(),
    title: z.string(),
    description: z.string(),
    status: Status,
    priority: Priority,
    assignee: Actor.nullable(),
    labels: z.array(z.string()),
    dueDate: z.string().nullable(),
    criteria: z.array(
      z.object({ id: z.string(), text: z.string(), done: z.boolean(), doneBy: Actor.nullable().optional() }),
    ),
    createdBy: Actor,
    source: z.record(z.string(), z.unknown()),
    channelId: z.uuid().nullable(),
    pullRequests: z.array(z.object({ number: z.number(), url: z.string(), openedBy: Actor.nullable() })),
    artifacts: z.array(z.object({ id: z.uuid(), title: z.string(), createdBy: Actor })),
    work: z
      .object({
        agentId: z.uuid(),
        runId: z.uuid().nullable(),
        state: z.enum(["running", "waiting_approval", "waiting_input", "stalled"]),
        since: z.string(),
        steps: z.array(z.object({ tool: z.string(), detail: z.string().optional(), at: z.string() })),
        reason: z.enum(["failed", "canceled", "budget"]).optional(),
      })
      .nullable()
      .openapi({
        description:
          "The assigned agent's work, from its runs: live (running, waiting) or stalled (in progress, no run alive).",
      }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Issue");

const Activity = z
  .object({
    id: z.uuid(),
    kind: z.enum(["comment", "event"]),
    author: Actor,
    text: z.string(),
    event: z.string().optional(),
    textCode: z.string().optional(),
    textParams: z.record(z.string(), z.string()).optional(),
    auto: z.boolean().optional().openapi({ description: "The system moved it on its own (runs and PRs)." }),
    attachments: z.array(z.object({ id: z.uuid(), title: z.string() })).optional(),
    createdAt: z.string(),
  })
  .openapi("IssueActivity");

const IssueParams = OrgParams.extend({ issueId: z.uuid() });

/** Native issues (D28): numbers per org, acceptance criteria, activity, "ask an agent to implement". */
export function issueRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const issues: IssueDeps = { db, pubsub: adapters.pubsub };
  const person = (userId: string) => ({ type: "person" as const, userId });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/issues",
      tags,
      security,
      summary: "Issues you can see, open ones first",
      request: {
        params: OrgParams,
        query: z.object({ q: z.string().max(200).optional(), status: Status.optional() }),
      },
      responses: { 200: json(z.object({ issues: z.array(Issue) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const query = c.req.valid("query");
      const list = await listIssues(db, person(c.get("user").id), orgId, { q: query.q, status: query.status });
      return c.json({ issues: list }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/issues/by-number/{number}",
      tags,
      security,
      summary: "An issue by its number (#131)",
      request: { params: OrgParams.extend({ number: z.coerce.number().int().min(1) }) },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, number } = c.req.valid("param");
      return c.json(await getIssue(db, person(c.get("user").id), orgId, { number }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/issues/{issueId}",
      tags,
      security,
      summary: "An issue",
      request: { params: IssueParams },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      return c.json(await getIssue(db, person(c.get("user").id), orgId, { id: issueId }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/issues",
      tags,
      security,
      summary: "Create an issue",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            title: z.string().min(1).max(300),
            description: z.string().max(50_000).optional(),
            criteria: z.array(z.string().max(500)).max(50).optional(),
            assignee: Actor.nullable().optional(),
            priority: Priority.optional(),
            dueDate: DueDate.optional(),
            labels: z.array(z.string().max(40)).max(20).optional(),
          }),
        ),
      },
      responses: { 201: json(Issue, "Created"), ...errors },
    }),
    async (c) => {
      const created = await createIssue(
        issues,
        person(c.get("user").id),
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json(created, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/issues/{issueId}",
      tags,
      security,
      summary: "Change an issue (each change goes to its activity)",
      request: {
        params: IssueParams,
        body: body(
          z.object({
            title: z.string().min(1).max(300).optional(),
            description: z.string().max(50_000).optional(),
            status: Status.optional(),
            priority: Priority.optional(),
            assignee: Actor.nullable().optional(),
            dueDate: DueDate.optional(),
            labels: z.array(z.string().max(40)).max(20).optional(),
          }),
        ),
      },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      return c.json(await updateIssue(issues, person(c.get("user").id), orgId, issueId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/issues/{issueId}/criteria/{criterionId}",
      tags,
      security,
      summary: "Check or uncheck an acceptance criterion",
      request: {
        params: IssueParams.extend({ criterionId: z.string() }),
        body: body(z.object({ done: z.boolean() })),
      },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, issueId, criterionId } = c.req.valid("param");
      const issue = await setCriterion(
        issues,
        person(c.get("user").id),
        orgId,
        issueId,
        criterionId,
        c.req.valid("json").done,
      );
      return c.json(issue, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/issues/{issueId}/activity",
      tags,
      security,
      summary: "Comments and events, oldest first",
      request: { params: IssueParams },
      responses: { 200: json(z.object({ activity: z.array(Activity) })), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      return c.json({ activity: await listIssueActivity(db, person(c.get("user").id), orgId, issueId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/issues/{issueId}/comments",
      tags,
      security,
      summary: "Comment on an issue",
      request: {
        params: IssueParams,
        body: body(
          z.object({
            text: z.string().max(20_000),
            attachmentIds: z
              .array(z.uuid())
              .max(10)
              .optional()
              .openapi({ description: "Drive files uploaded from the comment box (also linked to the issue)." }),
          }),
        ),
      },
      responses: { 201: json(Activity, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      const { text, attachmentIds } = c.req.valid("json");
      const comment = await commentIssue(issues, person(c.get("user").id), orgId, issueId, text, { attachmentIds });
      return c.json(comment, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/issues/{issueId}/ask-agent",
      tags,
      security,
      summary: '"Ask Ada to implement": assigns the agent and starts a run on the issue',
      request: { params: IssueParams, body: body(z.object({ agentId: z.uuid() })) },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      const issue = await askAgentToImplement(issues, c.get("user").id, orgId, issueId, c.req.valid("json").agentId);
      deps.wakeWorkers?.();
      return c.json(issue, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/issue",
      tags,
      security,
      summary: '"Transformar em issue": a message becomes an issue',
      request: {
        params: OrgParams.extend({ messageId: z.uuid() }),
        body: body(z.object({ title: z.string().max(300).optional() })),
      },
      responses: { 201: json(Issue, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await issueFromMessage(issues, c.get("user").id, orgId, messageId, c.req.valid("json")), 201);
    },
  );

  return app;
}
