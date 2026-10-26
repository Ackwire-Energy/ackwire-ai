import { STANDING_NOTICES, STANDING_STATES, setAgentHold, setOrgStanding, setUserBlocked } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

export const StandingState = z.enum(STANDING_STATES).openapi("OperatorStandingState", {
  description:
    "`active`; `hold`: its agents stop (no model, computer, routine or invitation), people still read and write; `suspended`: the workspace refuses everything to everyone, and its runs and tasks stop at once.",
});
export const StandingNotice = z.enum(STANDING_NOTICES).openapi("OperatorStandingNotice", {
  description:
    "`shown`: the workspace is told the reason, the change goes into its audit log and a new state notifies its owners and admins. `silent`: it is told only that it is paused, and nothing is written where it can read it.",
});

export const Standing = z
  .object({
    state: StandingState,
    reason: z.string().nullable(),
    note: z.string().nullable().openapi({ description: "The operator's own note: never shown to the workspace." }),
    notice: StandingNotice,
    changedAt: z.string().nullable().openapi({ description: "When `state` last changed; null: never." }),
  })
  .openapi("OperatorStanding");

const StandingInput = z.object({
  state: StandingState,
  reason: z.string().trim().min(1).max(64).openapi({ description: "Shown to the workspace with the notice `shown`." }),
  note: z.string().trim().max(2000).optional(),
  notice: StandingNotice,
});

/** The operator's own reason for a hold or a block: never shown to the workspace or the person. */
const Reason = z.string().trim().min(1).max(64).optional();

const AgentHold = z
  .object({
    held: z.boolean(),
    heldAt: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .openapi("OperatorAgentHold");

const UserBlock = z
  .object({
    blocked: z.boolean(),
    blockedAt: z.string().nullable(),
    reason: z.string().nullable(),
    sessionsRevoked: z.number().int().openapi({ description: "Sessions deleted by this call (0 when unblocking)." }),
  })
  .openapi("OperatorUserBlock");

const AgentParams = OrgParams.extend({ agentId: z.uuid().openapi({ param: { name: "agentId", in: "path" } }) });

export const UserParams = z.object({
  userId: z
    .string()
    .min(1)
    .max(200)
    .openapi({ param: { name: "userId", in: "path" } }),
});

/** The standing in the API's shape. */
export const standingJson = (s: {
  state: (typeof STANDING_STATES)[number];
  reason: string | null;
  note: string | null;
  notice: (typeof STANDING_NOTICES)[number];
  changedAt: Date | null;
}) => ({ ...s, changedAt: iso(s.changedAt) });

export function registerOperatorStanding(api: OpenAPIHono, { db, pubsub, hub }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/standing",
      tags,
      summary: "Hold, suspend or restore a workspace",
      description:
        "Enforced by this server where work starts: model calls, computer calls, routines, invitations and, when suspended, every permission check. Suspending also stops its runs and its tasks on computers now; cutting a computer's network is up to the operator's own controls on it. Held or suspended, it waits for no computer: what its provisioner last said goes (a ready computer stays), and it is a request again once active. It takes effect at once in this process and within 5 seconds in the server's others. Setting what is already set tells nobody again.",
      request: { params: OrgParams, body: body(StandingInput) },
      responses: { 200: json(Standing), ...errors },
    }),
    async (c) => {
      const { note, ...change } = c.req.valid("json");
      const standing = await setOrgStanding({ db, pubsub, hub }, c.req.valid("param").orgId, {
        ...change,
        note: note || null,
      });
      if (!standing) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json(standingJson(standing), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/agents/{agentId}/hold",
      tags,
      summary: "Hold one agent, or let it go",
      description:
        "Held, the agent starts nothing (no run, model call, computer work, routine or bridge call) and is never picked to answer; the rest of the workspace works. What it is doing stops at its next model, computer or bridge call. The workspace reads only that the agent is paused, never the reason. At once in this process, within 5 seconds in the others.",
      request: { params: AgentParams, body: body(z.object({ held: z.boolean(), reason: Reason })) },
      responses: { 200: json(AgentHold), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const { held, reason } = c.req.valid("json");
      const row = await setAgentHold(db, orgId, agentId, { held, reason: reason ?? null });
      if (!row) return apiError(c, 404, "not_found", "No agent with this id in this workspace");
      return c.json({ held: row.heldAt !== null, heldAt: iso(row.heldAt), reason: row.reason }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/users/{userId}/block",
      tags,
      summary: "Block an account, or let it back",
      description:
        "Blocked: its sessions and phones are signed out now, it can't sign in again, every workspace refuses it on its next request (no waiting for a session cookie to expire) and its open connections close. Unblocking lets it sign in again; it keeps its workspaces.",
      request: { params: UserParams, body: body(z.object({ blocked: z.boolean(), reason: Reason })) },
      responses: { 200: json(UserBlock), ...errors },
    }),
    async (c) => {
      const { blocked, reason } = c.req.valid("json");
      const state = await setUserBlocked({ db, pubsub }, c.req.valid("param").userId, {
        blocked,
        reason: reason ?? null,
      });
      if (!state) return apiError(c, 404, "not_found", "No account with this id");
      return c.json(
        {
          blocked: state.blockedAt !== null,
          blockedAt: iso(state.blockedAt),
          reason: state.reason,
          sessionsRevoked: state.sessionsRevoked,
        },
        200,
      );
    },
  );
}
