import { AUDIT_PAGE_MAX, listAudit } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Audit"];

const ActorType = z.enum(["person", "agent", "system"]);
const Outcome = z.enum(["done", "failed", "refused", "pending"]);

const AuditRow = z
  .object({
    id: z.string(),
    at: z.string(),
    actor: z.object({
      type: ActorType,
      id: z.string().nullable(),
      name: z.string().nullable().openapi({ description: "Null when the agent or person was removed." }),
    }),
    action: z.string().openapi({ description: "`tool.call` for an agent's tool call; e.g. `approval.approved`." }),
    target: z.object({ type: z.string(), id: z.string().nullable() }),
    details: z.record(z.string(), z.unknown()).openapi({
      description:
        "A tool call's: `kind`, `connector`, `behind` (`person`, `routine`, `unattended`), `input` (secrets masked, cut), `reason`, `approvalId`.",
    }),
    runId: z.string().nullable(),
    channelId: z.string().nullable(),
    onBehalfOf: z
      .object({ id: z.string(), name: z.string().nullable() })
      .nullable()
      .openapi({ description: "The person behind the agent's run." }),
    outcome: Outcome.nullable().openapi({ description: "A tool call's ending; null for the rest." }),
  })
  .openapi("AuditRow");

/** The org's audit log: what people changed and what agents did. Admins only (`configure`). */
export function auditRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/audit",
      tags,
      security,
      summary: "The audit log, newest first: agents' tool calls and people's changes (admins)",
      request: {
        params: OrgParams,
        query: z.object({
          actorType: ActorType.optional(),
          actorId: z.string().min(1).max(200).optional(),
          outcome: Outcome.optional(),
          kind: z.enum(["tool", "change"]).optional(),
          before: z.uuid().optional().openapi({ description: "`next` from the previous page." }),
          limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).optional(),
        }),
      },
      responses: {
        200: json(z.object({ rows: z.array(AuditRow), next: z.string().nullable() }).openapi("AuditPage")),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await listAudit(db, c.get("user").id, orgId, c.req.valid("query")), 200);
    },
  );

  return app;
}
