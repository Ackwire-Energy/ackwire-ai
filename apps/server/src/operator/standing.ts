import { STANDING_NOTICES, STANDING_STATES, setOrgStanding } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];

export const StandingState = z.enum(STANDING_STATES).openapi("OperatorStandingState", {
  description:
    "`active`; `hold`: its agents stop (no model, computer, routine or invitation), people still read and write; `suspended`: the workspace refuses everything to everyone.",
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

/** The standing in the API's shape. */
export const standingJson = (s: {
  state: (typeof STANDING_STATES)[number];
  reason: string | null;
  note: string | null;
  notice: (typeof STANDING_NOTICES)[number];
  changedAt: Date | null;
}) => ({ ...s, changedAt: iso(s.changedAt) });

export function registerOperatorStanding(api: OpenAPIHono, { db, pubsub }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/standing",
      tags,
      summary: "Hold, suspend or restore a workspace",
      description:
        "Enforced by this server where work starts: model calls, computer calls, routines, invitations and, when suspended, every permission check. It takes effect at once in this process and within 5 seconds in the server's others. Setting what is already set tells nobody again.",
      request: { params: OrgParams, body: body(StandingInput) },
      responses: {
        200: json(Standing),
        400: errorResponse("Invalid request"),
        401: errorResponse("Missing or wrong token"),
        404: errorResponse("Not found"),
      },
    }),
    async (c) => {
      const { note, ...change } = c.req.valid("json");
      const standing = await setOrgStanding({ db, pubsub }, c.req.valid("param").orgId, {
        ...change,
        note: note || null,
      });
      if (!standing) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json(standingJson(standing), 200);
    },
  );
}
