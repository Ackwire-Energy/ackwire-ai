import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { type AiStatusDeps, agentAiState } from "./ai-status";
import { canTalkTo, talksToAgents } from "./audience";
import { fedByRoutine, personOfMessage, runAuthorityById } from "./authority";
import { chainOfRun, sendNote } from "./consultations";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { getMessage, type Message, messageView } from "./messages";
import { notifyAgentUnreached } from "./notification-producers";
import { routineCreatorOf } from "./requester";
import type { RoutineBrief } from "./routine-brief";

const { agents, agentConsultations, channels, messages, routineRuns, routingDecisions } = schema;

/**
 * Why an agent's mention didn't wake the agent it names, the one vocabulary every skip uses (`routing_decisions.reason`,
 * `meta.reach`): `not_in_channel`, it isn't a member there (delivered as a note instead, when it may be reached);
 * `audience`, the person behind the message can't talk to it; `routine_creator_reach`, a routine is behind it and
 * its creator's reach (a routine set to act) or its "only look and tell" (one set to read) doesn't take it there.
 */
export type ReachReason = "not_in_channel" | "audience" | "routine_creator_reach";

/**
 * One agent a message named and didn't wake as a mention (`meta.reach`), what the people there read under it.
 * `consultationId`: delivered as a hand-off note to its private DM (only with `not_in_channel`). `outside`: also not a
 * member there. `userId`: whose reach fell short (the person behind it, or the routine's creator), so the agent's owner
 * can let them in. A routine behind it: its id, name, creator and access.
 */
export interface ReachEntry {
  agentId: string;
  handle: string;
  reason: ReachReason;
  consultationId?: string;
  outside?: true;
  /** `not_in_channel` from a private conversation: not forwarded, so what's said there stays there. */
  private?: true;
  /** `not_in_channel` to an agent with no AI connected: nothing could answer it. */
  noAi?: true;
  /** A routine's own message (`hand_off`) named a member: it wakes nobody (only tell_agent hands work on). */
  routinePost?: true;
  userId?: string;
  routine?: { id: string; name: string; creatorUserId: string | null; access: RoutineBrief["access"] };
}

/** `meta.reach`, read safely. */
export function reachOf(meta: Record<string, unknown> | null | undefined): ReachEntry[] {
  const list = meta?.reach;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is ReachEntry =>
      !!e && typeof e === "object" && typeof e.agentId === "string" && typeof e.handle === "string",
  );
}

/**
 * What the author reads in its next context about the agents its message named and didn't wake (`meta.reach`): who
 * got it as a note and how to reach them next time, who couldn't be called and why. "" when none.
 */
export function reachNote(entries: ReachEntry[]): string {
  return entries
    .map((e) => {
      if (e.consultationId)
        return `[Delivered as a note]: @${e.handle} isn't in this conversation, so your mention went to it as a note (tell_agent); what comes of it reaches you here. To reach it next time, use tell_agent or ask_agent.`;
      if (e.routinePost)
        return `[Not delivered]: @${e.handle} wasn't woken: a routine's message wakes nobody, even the agents it mentions. To get another agent to act, use tell_agent when the routine may act.`;
      if (e.noAi)
        return `[Not delivered]: @${e.handle} isn't in this conversation and has no AI connected, so nothing could answer it. The people here can see that.`;
      if (e.private)
        return `[Not delivered]: @${e.handle} isn't in this private conversation, so your mention wasn't forwarded (what's said here stays here). If it needs something, hand it with tell_agent in a note you write yourself, with only what it may know.`;
      const why =
        e.reason === "routine_creator_reach"
          ? e.routine?.access === "read"
            ? "the routine behind this was set to only look and tell, so it calls no other agent"
            : "it only works with some people, and the person who set up the routine behind this isn't one of them"
          : "it only works with some people, and the person you are helping isn't one of them";
      return `[Not delivered]: @${e.handle} wasn't called: ${why}. The people here can see that; don't mention it again for this, say what you need from it instead.`;
    })
    .join("\n");
}

/**
 * Whose reach a message's mentions have: the person behind it, or the creator of the routine set to act behind it
 * (`routineCreatorOf`); `routine`: the routine its chain roots in, if any (its bounds hold, ADR 0053 §4).
 */
export async function reachOfMessage(db: Database, message: Pick<Message, "orgId" | "id" | "agentRunId" | "meta">) {
  const person = await personOfMessage(db, message.orgId, message.id);
  const runId = message.agentRunId ?? (await routinePostRun(db, message));
  if (person || !runId) return { person, routine: null };
  const authority = await runAuthorityById(db, message.orgId, runId);
  const routine = authority.kind !== "person" && fedByRoutine(authority) ? (authority.brief ?? null) : null;
  return { person: routineCreatorOf(authority), routine };
}

/**
 * Of the agents outside a conversation a run's reply @names (handles), the ones `settleReach` will hand it to as a
 * note: in a public channel, to those whoever is behind the run may talk to and that aren't in its chain. For them the
 * mention is no unkept hand-off.
 */
export async function reachWillHand(
  db: Database,
  run: { orgId: string; id: string; triggerMessageId: string },
  channel: { kind: string; visibility: string },
  handles: string[],
): Promise<string[]> {
  if (handles.length === 0 || channel.kind !== "channel" || channel.visibility !== "public") return [];
  const behind = { orgId: run.orgId, id: run.triggerMessageId, agentRunId: run.id, meta: {} };
  const { person, routine } = await reachOfMessage(db, behind);
  if (routine?.access === "read") return [];
  const [rows, talks, chain] = await Promise.all([
    db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, run.orgId), inArray(agents.handle, handles), isNull(agents.archivedAt))),
    talksToAgents(db, run.orgId, person),
    chainOfRun(db, run.orgId, run.id),
  ]);
  return rows.filter((a) => !chain.includes(a.id) && canTalkTo(a, person, talks)).map((a) => a.handle);
}

/** The routine's background run behind a routine's own message (`hand_off`, `meta.routine`, posted with no run). */
export async function routinePostRun(db: Database, message: Pick<Message, "orgId" | "agentRunId" | "meta">) {
  const routine = message.meta.routine as { runId?: unknown } | undefined;
  if (message.agentRunId || message.meta.reminder || typeof routine?.runId !== "string") return null;
  const [row] = await db
    .select({ agentRunId: routineRuns.agentRunId })
    .from(routineRuns)
    .where(and(eq(routineRuns.orgId, message.orgId), eq(routineRuns.id, routine.runId)));
  return row?.agentRunId ?? null;
}

/**
 * Never silent (owner direction: a message meant for an agent reaches it, or someone is told why not). For an agent's
 * message once its mentions were dispatched: `outside`, agents of the workspace it @named that aren't members here
 * and that the judge read as needed, go as a hand-off note (`sendNote`, as `tell_agent`) when the person behind it
 * (or the routine's creator) may talk to them; `blocked`, members its mention didn't wake for who is behind it;
 * `routinePost`, members a routine's own message (`hand_off`) named, which it never wakes. Each
 * one is written on the message (`meta.reach`, the line under it, and the author's next context), in
 * `routing_decisions`, and, when a routine's creator couldn't reach an agent, told to that agent's owner.
 */
export async function settleReach(
  deps: { db: Database; pubsub?: PubSub } & Partial<Pick<AiStatusDeps, "gateway" | "machines">>,
  message: Message,
  input: { outside: string[]; blocked: string[]; routinePost?: string[] },
): Promise<ReachEntry[]> {
  const { db } = deps;
  const ids = [...new Set([...input.outside, ...input.blocked, ...(input.routinePost ?? [])])];
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, message.orgId), inArray(agents.id, ids), isNull(agents.archivedAt)));
  const { person, routine } = await reachOfMessage(db, message);
  const talks = await talksToAgents(db, message.orgId, person);
  const blockedReason: ReachReason = routine ? "routine_creator_reach" : "audience";
  const routineRef = routine
    ? { id: routine.routineId, name: routine.name, creatorUserId: routine.creatorUserId, access: routine.access }
    : undefined;
  // Whom the owner could let in: nobody when a routine that only looks is behind it (its access is what keeps it out).
  const who = routine?.access === "read" ? null : person;
  const blockedOf = (a: { id: string; handle: string }, outside: boolean): ReachEntry => ({
    agentId: a.id,
    handle: a.handle,
    reason: blockedReason,
    ...(outside ? { outside: true as const } : {}),
    ...(who ? { userId: who } : {}),
    ...(routineRef ? { routine: routineRef } : {}),
  });
  const entries: ReachEntry[] = [];
  for (const a of rows.filter((r) => input.blocked.includes(r.id))) entries.push(blockedOf(a, false));
  for (const a of rows.filter((r) => input.routinePost?.includes(r.id) && !input.blocked.includes(r.id)))
    entries.push({ agentId: a.id, handle: a.handle, reason: blockedReason, routinePost: true, routine: routineRef });
  const outside = rows.filter((r) => input.outside.includes(r.id) && !input.blocked.includes(r.id));
  if (outside.length > 0) {
    const [where] = await db
      .select({ name: channels.name, kind: channels.kind, visibility: channels.visibility })
      .from(channels)
      .where(and(eq(channels.orgId, message.orgId), eq(channels.id, message.channelId)));
    const [author] = message.authorAgentId
      ? await db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, message.authorAgentId))
      : [];
    const chain = message.agentRunId
      ? [...(await chainOfRun(db, message.orgId, message.agentRunId)), message.authorAgentId as string]
      : [];
    const place = where?.kind === "channel" ? `#${where.name}` : "a conversation";
    // Only a public channel's words go on whole: a private channel's or a DM's stay there (the author may tell_agent).
    const open = where?.kind === "channel" && where.visibility === "public";
    for (const a of outside) {
      // A routine set to only look and tell reaches no other agent; one set to act, only its creator's.
      const may =
        !!message.agentRunId &&
        !!message.authorAgentId &&
        routine?.access !== "read" &&
        !chain.includes(a.id) &&
        canTalkTo(a, person, talks);
      if (!may) {
        entries.push(blockedOf(a, true));
        continue;
      }
      if (!open) {
        entries.push({ agentId: a.id, handle: a.handle, reason: "not_in_channel", private: true });
        continue;
      }
      if (
        deps.gateway &&
        (await agentAiState({ db, gateway: deps.gateway, machines: deps.machines }, a)).state === "no_ai"
      ) {
        entries.push({ agentId: a.id, handle: a.handle, reason: "not_in_channel", noAi: true });
        continue;
      }
      // Already handed to it by this run (its own tell_agent): that note is the delivery.
      const [handed] = await db
        .select({ id: agentConsultations.id })
        .from(agentConsultations)
        .where(
          and(
            eq(agentConsultations.orgId, message.orgId),
            eq(agentConsultations.askerRunId, message.agentRunId as string),
            eq(agentConsultations.targetAgentId, a.id),
          ),
        )
        .limit(1);
      const sent = handed
        ? { consultationId: handed.id }
        : await sendNote(db, {
            orgId: message.orgId,
            agentId: message.authorAgentId as string,
            runId: message.agentRunId as string,
            hop: message.hop,
            targetAgentId: a.id,
            body: `[@${author?.handle ?? "an agent"} mentioned you in ${place}, where you aren't a member, so it reaches you here]\n\n${message.body}`,
            chain,
            fromMention: true,
          });
      if (!sent) continue;
      entries.push({ agentId: a.id, handle: a.handle, reason: "not_in_channel", consultationId: sent.consultationId });
      if (!handed && deps.pubsub && message.agentRunId) {
        await publishChannelEvent(deps.pubsub, {
          type: "agent.consulting",
          channelId: message.channelId,
          threadId: message.threadId,
          runId: message.agentRunId,
          agentId: message.authorAgentId as string,
          consultedAgentId: a.id,
          kind: "note",
        });
      }
    }
  }
  if (entries.length === 0) return [];
  await recordReach(db, message, entries);
  await db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{reach}', ${JSON.stringify(entries)}::jsonb)` })
    .where(and(eq(messages.orgId, message.orgId), eq(messages.id, message.id)));
  const updated = await getMessage(db, message.orgId, message.id);
  if (updated && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(updated));
  // Only a routine set to act that its creator's reach kept out: the agent's owner may let its creator in.
  for (const e of entries) {
    if (
      e.reason !== "routine_creator_reach" ||
      e.routinePost ||
      e.routine?.access !== "act" ||
      !e.routine.creatorUserId
    )
      continue;
    await notifyAgentUnreached(deps, {
      orgId: message.orgId,
      agentId: e.agentId,
      routineId: e.routine.id,
      routineName: e.routine.name,
      creatorUserId: e.routine.creatorUserId,
      channelId: message.channelId,
      threadId: message.threadId,
      messageId: message.id,
    });
  }
  return entries;
}

/** Each skip in the message's routing decision (one row per message): the reasons first, the judge's words after. */
async function recordReach(db: Database, message: Message, entries: ReachEntry[]) {
  const reason = entries.map((e) => `${e.reason}: @${e.handle}`).join(", ");
  const selected = entries.filter((e) => e.consultationId).map((e) => e.agentId);
  await db
    .insert(routingDecisions)
    .values({
      orgId: message.orgId,
      channelId: message.channelId,
      messageId: message.id,
      strategy: "reach",
      candidates: entries.map((e) => ({ agentId: e.agentId, score: 0 })),
      selectedAgentIds: selected,
      reason: reason.slice(0, 500),
    })
    .onConflictDoUpdate({
      target: routingDecisions.messageId,
      set: {
        reason: sql`left(concat_ws('; ', ${reason}::text, ${routingDecisions.reason}), 500)`,
      },
    });
}
