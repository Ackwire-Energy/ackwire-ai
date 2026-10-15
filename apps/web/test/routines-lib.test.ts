import { describe, expect, test } from "bun:test";
import type { Message } from "@/api/types";
import { buildTimeline } from "@/chat/timeline";
import { routineOfMessage, timezoneLabel, utcOffset } from "@/lib/routines";

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
  test("recognized by meta.routine; never grouped with the creator's own messages", () => {
    const routine = { routine: { id: "r1", name: "Relatório semanal", runId: "x" } };
    expect(routineOfMessage(routine)).toEqual({ id: "r1", name: "Relatório semanal" });
    expect(routineOfMessage({ routineId: "r1" })).toBeNull();
    expect(routineOfMessage(undefined)).toBeNull();
    const rows = buildTimeline([msg("typed", 1), msg("by-routine", 2, routine), msg("typed-again", 3)], [], []);
    const grouped = rows.flatMap((r) => (r.kind === "message" ? [[r.message.id, r.grouped]] : []));
    expect(grouped).toEqual([
      ["typed", false],
      ["by-routine", false],
      ["typed-again", false],
    ]);
  });
});

describe("time zones", () => {
  test("human labels with the offset; UTC stays plain; unknown zones by name", () => {
    const at = new Date(Date.UTC(2026, 9, 15, 12));
    expect(utcOffset("America/Sao_Paulo", at)).toBe("UTC−3");
    expect(timezoneLabel("America/Sao_Paulo", at)).toBe("horário de Brasília (UTC−3)");
    expect(timezoneLabel("Asia/Kolkata", at)).toBe("Asia/Kolkata (UTC+5:30)");
    expect(timezoneLabel("UTC", at)).toBe("UTC");
  });
});
