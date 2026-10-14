import {
  type CalendarDeps,
  calendarRange,
  confirmCalendarProposal,
  createCalendarEvent,
  dismissCalendarProposal,
  respondToEvent,
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

const tags = ["Calendar"];
const Actor = z.object({ type: z.enum(["person", "agent"]), id: z.string() });
const Recurrence = z.enum(["none", "weekdays", "weekly", "monthly"]);
const CalendarEvent = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: z.string(),
    start: z.string(),
    end: z.string(),
    allDay: z.boolean(),
    timezone: z.string(),
    recurrence: Recurrence,
    participants: z.array(Actor),
    rsvp: z.array(Actor.extend({ status: z.enum(["needs_action", "accepted", "declined"]) })),
    channelId: z.uuid().nullable(),
    issueId: z.uuid().nullable(),
    createdBy: Actor,
  })
  .openapi("CalendarEvent");
const Proposal = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    title: z.string(),
    start: z.string(),
    end: z.string(),
    participants: z.array(Actor),
    note: z.string().nullable(),
    status: z.enum(["pending", "confirmed", "dismissed"]),
  })
  .openapi("CalendarProposal");

/** The native calendar: events, agents' proposals (confirmed by a person), and a range view with routines and deadlines. */
export function calendarRoutes(deps: AppDeps) {
  const { db, adapters, config } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const calendar: CalendarDeps = { db, pubsub: adapters.pubsub, publicUrl: config.PUBLIC_URL };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/calendar",
      tags,
      security,
      summary: "Events, routine runs, issue deadlines and my pending proposals between from and to",
      request: { params: OrgParams, query: z.object({ from: z.string(), to: z.string() }) },
      responses: {
        200: json(
          z.object({
            events: z.array(CalendarEvent),
            routines: z.array(
              z.object({
                routineId: z.uuid(),
                name: z.string(),
                agentId: z.uuid(),
                at: z.string(),
                target: z.unknown(),
              }),
            ),
            deadlines: z.array(
              z.object({ issueId: z.uuid(), number: z.number(), title: z.string(), date: z.string() }),
            ),
            proposals: z.array(Proposal),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { from, to } = c.req.valid("query");
      return c.json(await calendarRange(calendar, c.get("user").id, orgId, from, to), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/calendar/events",
      tags,
      security,
      summary: "Create an event and invite the participants",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            title: z.string().min(1).max(200),
            description: z.string().max(10_000).optional(),
            start: z.string(),
            end: z.string(),
            allDay: z.boolean().optional(),
            timezone: z.string().max(64).optional(),
            recurrence: Recurrence,
            participants: z.array(Actor).max(100),
            channelId: z.uuid().nullable().optional(),
            issueId: z.uuid().nullable().optional(),
          }),
        ),
      },
      responses: { 201: json(CalendarEvent, "Created"), ...errors },
    }),
    async (c) => {
      const created = await createCalendarEvent(
        calendar,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json(created, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/calendar/events/{eventId}/rsvp",
      tags,
      security,
      summary: "Accept or decline an invitation",
      request: {
        params: OrgParams.extend({ eventId: z.uuid() }),
        body: body(z.object({ status: z.enum(["accepted", "declined"]) })),
      },
      responses: { 200: json(CalendarEvent), ...errors },
    }),
    async (c) => {
      const { orgId, eventId } = c.req.valid("param");
      return c.json(await respondToEvent(db, c.get("user").id, orgId, eventId, c.req.valid("json").status), 200);
    },
  );

  const ProposalParams = OrgParams.extend({ proposalId: z.uuid() });
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/calendar/proposals/{proposalId}/confirm",
      tags,
      security,
      summary: "Confirm an agent's proposal: creates the event and invites the people",
      request: { params: ProposalParams },
      responses: { 200: json(CalendarEvent), ...errors },
    }),
    async (c) => {
      const { orgId, proposalId } = c.req.valid("param");
      return c.json(await confirmCalendarProposal(calendar, c.get("user").id, orgId, proposalId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/calendar/proposals/{proposalId}/dismiss",
      tags,
      security,
      summary: "Dismiss an agent's proposal",
      request: { params: ProposalParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, proposalId } = c.req.valid("param");
      await dismissCalendarProposal(calendar, c.get("user").id, orgId, proposalId);
      return c.body(null, 204);
    },
  );

  return app;
}
