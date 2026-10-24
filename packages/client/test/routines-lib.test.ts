import { describe, expect, test } from "bun:test";
import type { Message } from "../src/index";
import { isRoutineCall, routineReplyOf, timezoneLabel, utcOffset } from "../src/lib/routines";
import { buildTimeline } from "../src/lib/timeline";

const walter = { type: "person" as const, id: "walter" };
const msg = (id: string, minute: number, meta?: Record<string, unknown>): Message => ({
  id,
  channelId: "c",
  threadId: null,
  author: walter,
  body: id,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString(),
  ...(meta ? { meta } : {}),
});

describe("routine messages", () => {
  test("the agent's message tagged with the routine it answers; a call written as its creator never shows", () => {
    const routine = { routine: { id: "r1", name: "Relatório semanal", runId: "rr1", noticeId: "n1" } };
    const answer = { ...msg("answer", 3, routine), author: { type: "agent" as const, id: "atlas" } };
    expect(routineReplyOf(answer)).toEqual({ id: "r1", name: "Relatório semanal", runId: "rr1", noticeId: "n1" });
    // Only an agent's message answers a routine; a reminder is the agent's own message.
    expect(routineReplyOf(msg("typed", 1, routine))).toBeNull();
    expect(routineReplyOf({ ...answer, meta: { ...routine, reminder: true } })).toBeNull();
    expect(routineReplyOf({ ...answer, meta: { routineId: "r1" } })).toBeNull();
    expect(routineReplyOf({ ...answer, meta: { routine: { id: "r1", name: "x" } } })).toEqual({
      id: "r1",
      name: "x",
      runId: null,
      noticeId: null,
    });
    expect(isRoutineCall(msg("by-routine", 2, routine))).toBe(true);
    expect(isRoutineCall(answer)).toBe(false);
    const inThread = { ...msg("in-thread", 4, routine), threadId: "root" };
    const rows = buildTimeline([msg("typed", 1), msg("by-routine", 2, routine), answer, inThread], [], []);
    const shown = rows.flatMap((r) => (r.kind === "message" ? [r.message.id] : []));
    expect(shown).toEqual(["typed", "answer"]);
  });
});

describe("time zones", () => {
  test("human labels with the offset; UTC stays plain; unknown zones by name", () => {
    const at = new Date(Date.UTC(2026, 9, 15, 12));
    expect(utcOffset("America/Sao_Paulo", at)).toBe("UTC−3");
    expect(timezoneLabel("America/Sao_Paulo", at)).toBe("horário de Brasília (UTC−3)");
    expect(timezoneLabel("Asia/Kolkata", at)).toBe("Índia (UTC+5:30)");
    // A zone without a friendly name keeps its IANA id (as in the selector, which shows the city).
    expect(timezoneLabel("Asia/Kathmandu", at)).toBe("Asia/Kathmandu (UTC+5:45)");
    expect(timezoneLabel("UTC", at)).toBe("UTC");
  });
});
