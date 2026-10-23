import { describe, expect, test } from "bun:test";
import type { Message } from "../src/index";
import { backgroundRoutineOf, isTalkerReply, noticeAgentHandle, noticeOf, noticeRoutineName } from "../src/lib/notices";
import { buildTimeline } from "../src/lib/timeline";

const ada = { type: "agent" as const, id: "ada" };
const walter = { type: "person" as const, id: "walter" };
const msg = (id: string, minute: number, author: Message["author"], meta?: Record<string, unknown>): Message => ({
  id,
  channelId: "c",
  threadId: null,
  author,
  body: id,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString(),
  ...(meta ? { meta } : {}),
});

describe("notices in a conversation", () => {
  test("a notice card; talker replies are normal messages with a hint", () => {
    const report = {
      notice: {
        kind: "routine_handoff",
        text: "3 erros novos",
        from: "Routine «Sentry diário»",
        refs: { runId: "r1" },
      },
    };
    const n = noticeOf(report);
    expect(n).toEqual({
      kind: "routine_handoff",
      text: "3 erros novos",
      from: "Routine «Sentry diário»",
      refs: { runId: "r1" },
    });
    expect(n && noticeRoutineName(report, n)).toBe("Sentry diário");
    const answer = noticeOf({ notice: { kind: "consult_reply", text: "Feito", from: "@infra" } });
    expect(answer && noticeAgentHandle(answer)).toBe("infra");

    expect(noticeOf({ talker: { runId: "r1" } })).toBeNull();
    // As the talker posts it: both metas; a normal message, never a card.
    const talker = { talker: { runId: "r1", inReplyTo: "m1" }, notice: { kind: "talker_reply", text: "Já vejo" } };
    expect(noticeOf(talker)).toBeNull();
    expect(isTalkerReply(talker)).toBe(true);
    expect(noticeOf({ notice: { kind: "talker_reply", text: "Já vejo" } })).toBeNull();
    expect(isTalkerReply({ talker: { runId: "r1" } })).toBe(true);
    expect(isTalkerReply({ notice: { kind: "talker_reply", text: "Já vejo" } })).toBe(true);
    expect(isTalkerReply({})).toBe(false);
    expect(noticeOf({ notice: { kind: "agent_note" } })).toBeNull();
  });

  test("a background routine's start is one line, not hidden; nothing groups with automatic lines", () => {
    const routine = { id: "rt", name: "Sentry diário", runId: "x" };
    expect(backgroundRoutineOf({ routine, background: true })).toEqual({ id: "rt", name: "Sentry diário" });
    expect(backgroundRoutineOf({ routine })).toBeNull();
    const items = buildTimeline(
      [
        msg("start", 0, walter, { routine, background: true }),
        msg("call", 1, walter, { routine }),
        msg("a1", 2, ada),
        msg("note", 3, ada, { notice: { kind: "routine_handoff", text: "r" } }),
        msg("a2", 4, ada),
        msg("a3", 5, ada, { talker: { runId: "r1" } }),
      ],
      [],
      [],
    ).flatMap((i) => (i.kind === "message" ? [[i.message.id, i.grouped] as const] : []));
    expect(items).toEqual([
      ["start", false],
      ["a1", false],
      ["note", false],
      ["a2", false],
      // A fast reply while it works keeps its header ("enquanto trabalha").
      ["a3", false],
    ]);
  });
});
