import { expect } from "bun:test";
import { and, eq, inArray, lte, schema } from "@agenteschat/db";
import { REFUSALS } from "../../src";
import type { World } from "./harness";
import { merged } from "./known";

/**
 * The invariants every scenario must keep at its end, whatever it is about (ops design "autonomy as invariants",
 * §1): a predicate over the rows. A path that breaks one fails some existing scenario even if nobody wrote a test
 * for it. Each check returns the violations it found; `assertInvariants` fails on any.
 */

/** Refusals that mean a turn couldn't do what its agent is allowed to do (I4); a read routine's are expected. */
const CANT_ACT = [
  REFUSALS.unattendedElsewhere,
  REFUSALS.unattendedInternal,
  REFUSALS.missionOnly,
  REFUSALS.unknownTool,
];

export async function violations(w: World): Promise<string[]> {
  const out: string[] = [];
  const now = new Date();
  const runs = await w.runs();
  const ids = runs.map((r) => r.id);
  const steps = await w.steps(ids);
  const who = (agentId: string) => `@${w.handleOf(agentId)}`;

  // Quiescence: nothing left running or due (every scenario drains to the end).
  for (const r of runs)
    if (r.status === "queued" || r.status === "running") out.push(`I2: ${who(r.agentId)}'s run is still ${r.status}`);
  const due = await w.db
    .select({ kind: schema.outbox.kind })
    .from(schema.outbox)
    .where(
      and(
        eq(schema.outbox.orgId, w.org.id),
        eq(schema.outbox.status, "pending"),
        lte(schema.outbox.nextAttemptAt, now),
      ),
    );
  for (const j of due) out.push(`I2: job ${j.kind} is due and was never run`);

  // I2: a run that waits shows what it waits on, where someone sees it.
  const questions = ids.length
    ? await w.db.select().from(schema.agentQuestions).where(inArray(schema.agentQuestions.runId, ids))
    : [];
  const approvals = ids.length
    ? await w.db.select().from(schema.approvals).where(inArray(schema.approvals.runId, ids))
    : [];
  for (const r of runs) {
    if (r.status === "waiting_input" && !questions.some((x) => x.runId === r.id && x.status === "open"))
      out.push(`I2: ${who(r.agentId)} waits for input with no open question`);
    if (r.status === "waiting_approval" && !approvals.some((x) => x.runId === r.id && x.status === "pending"))
      out.push(`I2: ${who(r.agentId)} waits for approval with no pending card`);
  }
  // The continuation controller records each turn's end on a step (`data.continuation`); make this unconditional
  // when it merges.
  if (merged.has("controller"))
    for (const r of runs.filter((r) => r.status === "done" && !r.background))
      if (!steps.some((s) => s.runId === r.id && s.data.continuation !== undefined))
        out.push(`I2: ${who(r.agentId)}'s run ended with no recorded continuation outcome`);

  // I3: every hand-off between agents is closed and reported back.
  const consultations = await w.db
    .select()
    .from(schema.agentConsultations)
    .where(eq(schema.agentConsultations.orgId, w.org.id));
  const notices = (
    await w.db.select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.orgId, w.org.id))
  ).map((m) => (m.meta.notice ?? {}) as { kind?: string; refs?: Record<string, unknown> });
  for (const c of consultations) {
    const pair = `${who(c.askerAgentId)} → ${who(c.targetAgentId)}`;
    const target = runs.find((r) => r.id === c.targetRunId);
    const targetWaitsOnPerson = target?.status === "waiting_input" || target?.status === "waiting_approval";
    if (c.status === "open" && !targetWaitsOnPerson) out.push(`I3: hand-off ${pair} is still open`);
    if (c.status !== "open" && c.waitId.startsWith("async:")) {
      const reported = notices.some(
        (n) =>
          n.kind === "consult_reply" && n.refs?.askerAgentId === c.askerAgentId && n.refs?.agentId === c.targetAgentId,
      );
      if (!reported) out.push(`I3: hand-off ${pair} closed ${c.status} and was never reported back`);
    }
  }

  // I4: no turn was refused what its agent may do, outside a routine set to only look.
  for (const s of steps.filter((s) => s.kind === "tool_result" && s.data.isError === true)) {
    const content = String(s.data.content ?? "");
    if (CANT_ACT.some((r) => r && content.startsWith(r.slice(0, 40)))) {
      const r = runs.find((x) => x.id === s.runId);
      out.push(`I4: ${who(r?.agentId ?? "")} was refused: ${content.slice(0, 80)}`);
    }
  }

  // I5: a failed run reaches someone who can act (a notification naming it or its agent), or waits to resume.
  const notifications = await w.db.select().from(schema.notifications).where(eq(schema.notifications.orgId, w.org.id));
  for (const r of runs.filter((r) => r.status === "failed" && !r.background)) {
    const told = notifications.some((n) => {
      const text = JSON.stringify([n.source, n.latest]);
      return /fail|error|stopp/i.test(n.kind) && (text.includes(r.id) || text.includes(r.agentId));
    });
    if (!told) out.push(`I5: ${who(r.agentId)}'s run failed (${r.error}) and nobody was told`);
  }

  // I6: nothing worked that nobody scripted, and no run was nudged past the bound.
  for (const u of w.unscripted)
    out.push(`I6: @${u.handle} made an unscripted model call after "${u.last.slice(0, 80)}"`);
  for (const r of runs) {
    const nudges = steps.filter((s) => s.runId === r.id && s.data.nudged !== undefined).length;
    if (nudges > 3) out.push(`I6: ${who(r.agentId)}'s run was nudged ${nudges} times`);
  }

  // The harness itself: a judgment no table answers would pass silently.
  for (const k of new Set(w.unknownJudgments)) out.push(`harness: unknown judgment kind ${k}`);
  for (const body of w.unrouted) out.push(`harness: no route for "${body.slice(0, 80)}"`);
  return out;
}

export async function assertInvariants(w: World) {
  expect(await violations(w)).toEqual([]);
}
