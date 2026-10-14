import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, gte, inArray, isNull, lte, or, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { nextCronTime, zonedParts, zonedTime } from "./cron";
import { queueEmail } from "./email";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated, publishUserEvent } from "./events";
import { getOrgSettings } from "./management";
import { insertMessage, messageView } from "./messages";
import { can, getMembership, requirePermission } from "./organizations";

const {
  calendarEvents,
  calendarAttendees,
  calendarProposals,
  channelMembers,
  channels,
  issues,
  routines,
  organizationMembers,
  agents,
  users,
  organizations,
} = schema;

export type Recurrence = "none" | "weekdays" | "weekly" | "monthly";
export const RECURRENCES: readonly Recurrence[] = ["none", "weekdays", "weekly", "monthly"];
export interface CalendarActor {
  type: "person" | "agent";
  id: string;
}

export interface CalendarEventView {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  recurrence: Recurrence;
  participants: CalendarActor[];
  /** RSVP of each person attending. */
  rsvp: { type: "person" | "agent"; id: string; status: "needs_action" | "accepted" | "declined" }[];
  channelId: string | null;
  issueId: string | null;
  createdBy: CalendarActor;
}

export interface CalendarProposalView {
  id: string;
  agentId: string;
  title: string;
  start: string;
  end: string;
  participants: CalendarActor[];
  note: string | null;
  status: "pending" | "confirmed" | "dismissed";
}

export interface CalendarEventInput {
  title: string;
  description?: string;
  start: string;
  end: string;
  allDay?: boolean;
  timezone?: string;
  recurrence: Recurrence;
  participants: CalendarActor[];
  channelId?: string | null;
  issueId?: string | null;
}

export interface CalendarDeps {
  db: Database;
  pubsub?: PubSub;
  publicUrl?: string;
}

type EventRow = typeof calendarEvents.$inferSelect;
type ProposalRow = typeof calendarProposals.$inferSelect;

const RRULES: Record<Recurrence, string | null> = {
  none: null,
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
};

const MAX_OCCURRENCES = 400;

/**
 * Occurrences of an event between `from` and `to`, keeping its wall-clock
 * time in its time zone (so a 9:00 meeting stays at 9:00 across DST).
 */
export function occurrences(e: Pick<EventRow, "startAt" | "endAt" | "recurrence" | "timezone">, from: Date, to: Date) {
  const duration = e.endAt.getTime() - e.startAt.getTime();
  const overlaps = (start: Date) => start.getTime() < to.getTime() && start.getTime() + duration > from.getTime();
  if (e.recurrence === "none") return overlaps(e.startAt) ? [{ start: e.startAt, end: e.endAt }] : [];
  const tz = e.timezone || "UTC";
  const base = zonedParts(e.startAt, tz);
  const out: { start: Date; end: Date }[] = [];
  for (let i = 0; i < 5000 && out.length < MAX_OCCURRENCES; i++) {
    let y = base.year;
    let mo = base.month;
    let d = base.day;
    if (e.recurrence === "monthly") {
      mo = base.month + i;
      y = base.year + Math.floor((mo - 1) / 12);
      mo = ((mo - 1) % 12) + 1;
    } else {
      const step = e.recurrence === "weekly" ? 7 * i : i;
      const day = new Date(Date.UTC(base.year, base.month - 1, base.day + step));
      y = day.getUTCFullYear();
      mo = day.getUTCMonth() + 1;
      d = day.getUTCDate();
      const weekday = day.getUTCDay();
      if (e.recurrence === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    }
    const start = zonedTime(y, mo, d, base.hour, base.minute, tz);
    if (!start) continue; // the day doesn't exist (31st) or the time was skipped by DST
    if (start.getTime() >= to.getTime()) break;
    if (overlaps(start)) out.push({ start, end: new Date(start.getTime() + duration) });
  }
  return out;
}

async function attendeesOf(db: Database, eventIds: string[]) {
  if (eventIds.length === 0) return [];
  return db.select().from(calendarAttendees).where(inArray(calendarAttendees.eventId, eventIds));
}

function view(
  e: EventRow,
  attendees: (typeof calendarAttendees.$inferSelect)[],
  occurrence?: { start: Date; end: Date },
): CalendarEventView {
  const mine = attendees.filter((a) => a.eventId === e.id);
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    start: (occurrence?.start ?? e.startAt).toISOString(),
    end: (occurrence?.end ?? e.endAt).toISOString(),
    allDay: e.allDay,
    timezone: e.timezone,
    recurrence: (RECURRENCES.includes(e.recurrence as Recurrence) ? e.recurrence : "none") as Recurrence,
    participants: mine.map((a) => ({ type: a.attendeeType as CalendarActor["type"], id: a.attendeeId })),
    rsvp: mine.map((a) => ({
      type: a.attendeeType as CalendarActor["type"],
      id: a.attendeeId,
      status: a.status as CalendarEventView["rsvp"][number]["status"],
    })),
    channelId: e.channelId,
    issueId: e.issueId,
    createdBy: { type: e.createdByType as CalendarActor["type"], id: e.createdById },
  };
}

const proposalView = (p: ProposalRow): CalendarProposalView => ({
  id: p.id,
  agentId: p.agentId,
  title: p.title,
  start: p.startAt.toISOString(),
  end: p.endAt.toISOString(),
  participants: p.participants as CalendarActor[],
  note: p.note,
  status: p.status as CalendarProposalView["status"],
});

async function checkParticipants(db: Database, orgId: string, participants: CalendarActor[]) {
  const people = participants.filter((p) => p.type === "person").map((p) => p.id);
  const bots = participants.filter((p) => p.type === "agent").map((p) => p.id);
  if (people.length > 0) {
    const found = await db
      .select({ id: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, people)));
    if (found.length !== new Set(people).size)
      throw new ValidationError("Every participant must be in the organization");
  }
  if (bots.length > 0) {
    const found = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, bots), isNull(agents.archivedAt)));
    if (found.length !== new Set(bots).size) throw new ValidationError("Every agent must be in the organization");
  }
}

/** "seg., 20 de out. de 2026, 09:00" in a time zone. */
const formatWhen = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(d);

/** Tells invited people: in the app, and by email. */
async function notifyInvited(deps: CalendarDeps, e: EventRow, inviterId: string, people: string[]) {
  if (people.length === 0) return;
  const [inviter] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, inviterId));
  const [org] = await deps.db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, e.orgId));
  const rows = await deps.db
    .select({ id: users.id, email: users.email, tz: organizationMembers.timezone })
    .from(users)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, e.orgId)),
    )
    .where(inArray(users.id, people));
  for (const r of rows) {
    await publishUserEvent(deps.pubsub, e.orgId, r.id, { type: "calendar.invited", eventId: e.id, title: e.title });
    await queueEmail(deps.db, {
      orgId: e.orgId,
      key: `calendar-invite:${e.id}:${r.id}`,
      to: [r.email],
      template: {
        kind: "calendar_invite",
        orgName: org?.name ?? "",
        inviterName: inviter?.name ?? "Alguém",
        title: e.title,
        when: formatWhen(e.startAt, r.tz ?? e.timezone),
        url: `${(deps.publicUrl ?? "").replace(/\/$/, "")}/org/${e.orgId}/calendar`,
      },
    });
  }
}

/** People create events; attendees (people and agents) are invited, the creator has accepted. */
export async function createCalendarEvent(
  deps: CalendarDeps,
  userId: string,
  orgId: string,
  input: CalendarEventInput,
): Promise<CalendarEventView> {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "post");
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new ValidationError("title is required");
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new ValidationError("end must be after start");
  }
  if (!RECURRENCES.includes(input.recurrence)) throw new ValidationError("invalid recurrence");
  const settings = await getOrgSettings(db, userId, orgId);
  const timezone = input.timezone ?? settings.timezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ValidationError("timezone must be an IANA time zone");
  }
  const participants = input.participants.filter((p) => !(p.type === "person" && p.id === userId));
  await checkParticipants(db, orgId, participants);
  if (input.channelId) {
    const [member] = await db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, input.channelId), eq(channelMembers.userId, userId)));
    if (!member) throw new NotFoundError("Channel not found");
  }
  if (input.issueId) {
    const [issue] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.orgId, orgId)));
    if (!issue) throw new NotFoundError("Issue not found");
  }
  const event = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(calendarEvents)
      .values({
        orgId,
        title,
        description: (input.description ?? "").slice(0, 10_000),
        startAt: start,
        endAt: end,
        allDay: input.allDay === true,
        timezone,
        recurrence: input.recurrence,
        rrule: RRULES[input.recurrence],
        channelId: input.channelId ?? null,
        issueId: input.issueId ?? null,
        createdByType: "person",
        createdById: userId,
      })
      .returning();
    if (!row) throw new Error("event insert returned nothing");
    const seen = new Set<string>();
    const list = [{ type: "person" as const, id: userId }, ...participants].filter((p) => {
      const key = `${p.type}:${p.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await tx.insert(calendarAttendees).values(
      list.map((p) => ({
        orgId,
        eventId: row.id,
        attendeeType: p.type,
        attendeeId: p.id,
        status: p.type === "person" && p.id === userId ? "accepted" : "needs_action",
        respondedAt: p.type === "person" && p.id === userId ? new Date() : null,
      })),
    );
    return row;
  });
  await notifyInvited(
    deps,
    event,
    userId,
    participants.filter((p) => p.type === "person").map((p) => p.id),
  );
  const result = view(event, await attendeesOf(db, [event.id]));
  if (event.channelId) {
    await publishChannelEvent(deps.pubsub, {
      type: "calendar.event_created",
      channelId: event.channelId,
      event: result,
    });
  }
  return result;
}

/** RSVP of a person to an event they're invited to. */
export async function respondToEvent(
  db: Database,
  userId: string,
  orgId: string,
  eventId: string,
  status: "accepted" | "declined",
) {
  const [row] = await db
    .update(calendarAttendees)
    .set({ status, respondedAt: new Date() })
    .where(
      and(
        eq(calendarAttendees.orgId, orgId),
        eq(calendarAttendees.eventId, eventId),
        eq(calendarAttendees.attendeeType, "person"),
        eq(calendarAttendees.attendeeId, userId),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("You are not invited to this event");
  const [event] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId));
  if (!event) throw new NotFoundError("Event not found");
  return view(event, await attendeesOf(db, [eventId]));
}

/** Events a person sees: theirs (invited or created) and those of channels they're in. */
async function visibleEvents(db: Database, userId: string, orgId: string, from: Date, to: Date) {
  const invited = db
    .select({ id: calendarAttendees.eventId })
    .from(calendarAttendees)
    .where(
      and(
        eq(calendarAttendees.orgId, orgId),
        eq(calendarAttendees.attendeeType, "person"),
        eq(calendarAttendees.attendeeId, userId),
      ),
    );
  const myChannels = db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, userId)));
  return db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.orgId, orgId),
        isNull(calendarEvents.deletedAt),
        lte(calendarEvents.startAt, to),
        or(sql`${calendarEvents.recurrence} <> 'none'`, gte(calendarEvents.endAt, from)),
        or(inArray(calendarEvents.id, invited), inArray(calendarEvents.channelId, myChannels)),
      ),
    );
}

/** The calendar view: events (with recurrences expanded), routine runs, issue deadlines and my pending proposals. */
export async function calendarRange(deps: CalendarDeps, userId: string, orgId: string, fromIso: string, toIso: string) {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "read");
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new ValidationError("to must be after from");
  }
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new ValidationError("The range is too long");
  const rows = await visibleEvents(db, userId, orgId, from, to);
  const attendees = await attendeesOf(
    db,
    rows.map((r) => r.id),
  );
  const events = rows
    .flatMap((r) => occurrences(r, from, to).map((o) => view(r, attendees, o)))
    .sort((a, b) => a.start.localeCompare(b.start));

  const routineRows = await db
    .select()
    .from(routines)
    .where(and(eq(routines.orgId, orgId), eq(routines.active, true), eq(routines.triggerType, "schedule")));
  const routineRuns: { routineId: string; name: string; agentId: string; at: string; target: unknown }[] = [];
  for (const r of routineRows) {
    if (!r.cron) continue;
    let at = nextCronTime(r.cron, r.timezone ?? "UTC", new Date(from.getTime() - 1));
    for (let i = 0; at && at < to && i < 200; i++) {
      routineRuns.push({ routineId: r.id, name: r.name, agentId: r.agentId, at: at.toISOString(), target: r.target });
      at = nextCronTime(r.cron, r.timezone ?? "UTC", at);
    }
  }

  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);
  const due = await db
    .select({
      id: issues.id,
      number: issues.number,
      title: issues.title,
      date: issues.dueDate,
      channelId: issues.channelId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        sql`${issues.dueDate} >= ${fromDay}::date`,
        sql`${issues.dueDate} <= ${toDay}::date`,
        sql`${issues.status} not in ('done', 'canceled')`,
      ),
    );
  const mine = new Set(
    (
      await db
        .select({ id: channelMembers.channelId })
        .from(channelMembers)
        .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, userId)))
    ).map((r) => r.id),
  );
  const deadlines = due
    .filter((d) => !d.channelId || mine.has(d.channelId))
    .map((d) => ({ issueId: d.id, number: d.number, title: d.title, date: d.date ?? "" }));

  const proposals = (
    await db
      .select()
      .from(calendarProposals)
      .where(
        and(
          eq(calendarProposals.orgId, orgId),
          eq(calendarProposals.requesterUserId, userId),
          eq(calendarProposals.status, "pending"),
        ),
      )
  ).map(proposalView);
  return { events, routines: routineRuns, deadlines, proposals };
}

/** Busy blocks (no details) of people and agents between two instants. */
async function busy(db: Database, orgId: string, who: CalendarActor[], from: Date, to: Date) {
  if (who.length === 0) return [];
  const rows = await db
    .select({ event: calendarEvents, attendee: calendarAttendees })
    .from(calendarAttendees)
    .innerJoin(calendarEvents, eq(calendarEvents.id, calendarAttendees.eventId))
    .where(
      and(
        eq(calendarAttendees.orgId, orgId),
        inArray(
          calendarAttendees.attendeeId,
          who.map((w) => w.id),
        ),
        sql`${calendarAttendees.status} <> 'declined'`,
        isNull(calendarEvents.deletedAt),
        lte(calendarEvents.startAt, to),
      ),
    );
  return rows.flatMap((r) => occurrences(r.event, from, to));
}

/**
 * Free slots for everyone in `who`, on weekdays between 9:00 and 18:00 in
 * the org's time zone, from `from` for `days` days. Only busy/free: agents
 * never see other people's event details this way.
 */
export async function findFreeTime(
  db: Database,
  orgId: string,
  who: CalendarActor[],
  options: { durationMinutes: number; from: Date; days: number; timezone: string; limit?: number },
) {
  const to = new Date(options.from.getTime() + options.days * 86_400_000);
  const blocks = await busy(db, orgId, who, options.from, to);
  const duration = options.durationMinutes * 60_000;
  const slots: { start: string; end: string }[] = [];
  const step = 30 * 60_000;
  let t = Math.ceil(options.from.getTime() / step) * step;
  while (t + duration <= to.getTime() && slots.length < (options.limit ?? 3)) {
    const p = zonedParts(new Date(t), options.timezone);
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const endParts = zonedParts(new Date(t + duration), options.timezone);
    const inHours =
      weekday !== 0 &&
      weekday !== 6 &&
      p.hour >= 9 &&
      (endParts.hour < 18 || (endParts.hour === 18 && endParts.minute === 0));
    const clash = blocks.some((b) => b.start.getTime() < t + duration && b.end.getTime() > t);
    if (inHours && !clash) {
      slots.push({ start: new Date(t).toISOString(), end: new Date(t + duration).toISOString() });
      t += duration;
    } else t += step;
  }
  return slots;
}

/**
 * An agent suggests an event. Nothing is created: the person who asked gets
 * an inline card in the conversation and confirms (or dismisses) it.
 */
export async function proposeCalendarEvent(
  deps: CalendarDeps,
  run: {
    orgId: string;
    agentId: string;
    runId: string;
    channelId: string;
    threadRootId: string;
    triggerMessageId: string;
  },
  input: {
    title: string;
    description?: string;
    start: string;
    end: string;
    participants: CalendarActor[];
    note?: string;
  },
): Promise<CalendarProposalView> {
  const { db } = deps;
  const [trigger] = await db
    .select({ userId: schema.messages.authorUserId, channelKind: channels.kind })
    .from(schema.messages)
    .innerJoin(channels, eq(channels.id, schema.messages.channelId))
    .where(and(eq(schema.messages.id, run.triggerMessageId), eq(schema.messages.orgId, run.orgId)));
  if (!trigger?.userId) throw new ValidationError("Only a person's request can lead to an event proposal");
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new ValidationError("end must be after start");
  }
  await checkParticipants(db, run.orgId, input.participants);
  const flat = trigger.channelKind === "dm" && run.threadRootId === run.triggerMessageId;
  const proposal = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(calendarProposals)
      .values({
        orgId: run.orgId,
        agentId: run.agentId,
        runId: run.runId,
        requesterUserId: trigger.userId as string,
        channelId: run.channelId,
        title: input.title.trim().slice(0, 200),
        description: (input.description ?? "").slice(0, 10_000),
        startAt: start,
        endAt: end,
        participants: input.participants,
        note: input.note?.slice(0, 300) ?? null,
      })
      .returning();
    if (!row) throw new Error("proposal insert returned nothing");
    const card = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId: flat ? null : run.threadRootId,
      author: { type: "agent", agentId: run.agentId, runId: run.runId, hop: 1 },
      body: `Proposta de evento: ${row.title}`,
      meta: { calendarProposalId: row.id, calendarProposal: proposalView(row) },
    });
    const [linked] = await tx
      .update(calendarProposals)
      .set({ messageId: card.id })
      .where(eq(calendarProposals.id, row.id))
      .returning();
    return { row: linked ?? row, card };
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(proposal.card));
  await publishUserEvent(deps.pubsub, run.orgId, trigger.userId, {
    type: "calendar.proposal",
    proposal: proposalView(proposal.row),
  });
  return proposalView(proposal.row);
}

async function decideProposalRow(db: Database, userId: string, orgId: string, id: string) {
  const [p] = await db
    .select()
    .from(calendarProposals)
    .where(and(eq(calendarProposals.id, id), eq(calendarProposals.orgId, orgId)));
  if (!p) throw new NotFoundError("Proposal not found");
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  if (p.requesterUserId !== userId && !can(membership.role, "configure")) {
    throw new ForbiddenError("Only the person who asked can confirm this");
  }
  if (p.status !== "pending") throw new ValidationError("This proposal was already decided");
  return p;
}

async function syncProposalCard(db: Database, p: ProposalRow) {
  if (!p.messageId) return;
  await db
    .update(schema.messages)
    .set({
      meta: sql`jsonb_set(${schema.messages.meta}, '{calendarProposal}', ${JSON.stringify(proposalView(p))}::jsonb)`,
    })
    .where(and(eq(schema.messages.id, p.messageId), eq(schema.messages.orgId, p.orgId)));
}

/** The person who asked confirms: the event is created (by them) and the participants are invited. */
export async function confirmCalendarProposal(deps: CalendarDeps, userId: string, orgId: string, id: string) {
  const p = await decideProposalRow(deps.db, userId, orgId, id);
  const agent = await getAgent(deps.db, orgId, p.agentId);
  const participants = [
    ...(p.participants as CalendarActor[]),
    ...(agent ? [{ type: "agent" as const, id: agent.id }] : []),
  ];
  const event = await createCalendarEvent(deps, userId, orgId, {
    title: p.title,
    description: p.description,
    start: p.startAt.toISOString(),
    end: p.endAt.toISOString(),
    recurrence: "none",
    participants,
    channelId: null,
  });
  const [row] = await deps.db
    .update(calendarProposals)
    .set({ status: "confirmed", eventId: event.id })
    .where(eq(calendarProposals.id, p.id))
    .returning();
  if (row) await syncProposalCard(deps.db, row);
  return event;
}

export async function dismissCalendarProposal(deps: CalendarDeps, userId: string, orgId: string, id: string) {
  const p = await decideProposalRow(deps.db, userId, orgId, id);
  const [row] = await deps.db
    .update(calendarProposals)
    .set({ status: "dismissed" })
    .where(eq(calendarProposals.id, p.id))
    .returning();
  if (row) await syncProposalCard(deps.db, row);
}

/** Resolves `@ana` / `@dev` handles (or ids) to people and agents of the org. */
export async function resolveParticipants(db: Database, orgId: string, refs: string[]): Promise<CalendarActor[]> {
  const handles = refs.map((r) => r.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
  if (handles.length === 0) return [];
  const [people, bots] = await Promise.all([
    db
      .select({ id: organizationMembers.userId, handle: organizationMembers.handle })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.handle, handles))),
    db
      .select({ id: agents.id, handle: agents.handle })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.handle, handles), isNull(agents.archivedAt))),
  ]);
  const out: CalendarActor[] = [
    ...people.map((p) => ({ type: "person" as const, id: p.id })),
    ...bots.map((b) => ({ type: "agent" as const, id: b.id })),
  ];
  const known = new Set([...people.map((p) => p.handle), ...bots.map((b) => b.handle)]);
  const unknown = handles.filter((h) => !known.has(h));
  if (unknown.length > 0) throw new ValidationError(`Não encontrei ${unknown.map((h) => `@${h}`).join(", ")}`);
  return out;
}

/** Events an agent may see: those it attends and those of channels it can read in this run. */
export async function agentEvents(
  db: Database,
  orgId: string,
  agentId: string,
  visibleChannelIds: string[],
  from: Date,
  to: Date,
) {
  const attending = db
    .select({ id: calendarAttendees.eventId })
    .from(calendarAttendees)
    .where(
      and(
        eq(calendarAttendees.orgId, orgId),
        eq(calendarAttendees.attendeeType, "agent"),
        eq(calendarAttendees.attendeeId, agentId),
      ),
    );
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.orgId, orgId),
        isNull(calendarEvents.deletedAt),
        lte(calendarEvents.startAt, to),
        visibleChannelIds.length > 0
          ? or(inArray(calendarEvents.id, attending), inArray(calendarEvents.channelId, visibleChannelIds))
          : inArray(calendarEvents.id, attending),
      ),
    );
  const attendees = await attendeesOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.flatMap((r) => occurrences(r, from, to).map((o) => view(r, attendees, o)));
}
