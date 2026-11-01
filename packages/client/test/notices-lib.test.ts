import { describe, expect, test } from "bun:test";
import type { Message } from "../src/index";
import { formatShortDate } from "../src/lib/format";
import {
  answeredNotices,
  consultationOfNotice,
  followUpLine,
  isTalkerReply,
  noticeAgentHandle,
  noticeOf,
  noticeRoutineName,
  routineReportText,
} from "../src/lib/notices";
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
    expect(n && noticeRoutineName(n)).toBe("Sentry diário");
    const byRefs = noticeOf({ notice: { kind: "routine_handoff", text: "x", refs: { routineName: "Bom dia" } } });
    expect(byRefs && noticeRoutineName(byRefs)).toBe("Bom dia");
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

  test("a routine's call written as its creator never shows; nothing groups with automatic lines", () => {
    const routine = { id: "rt", name: "Sentry diário", runId: "x" };
    const items = buildTimeline(
      [
        // Before routines fired in their own room: a firing and a call written as the creator.
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
      ["a1", false],
      // A report nobody answered yet: its compact line.
      ["note", false],
      ["a2", false],
      // A fast reply while it works keeps its header ("enquanto trabalha").
      ["a3", false],
    ]);
  });

  test("a report the agent told people about folds into its message; the tag can unfold it", () => {
    const report = msg("notice", 0, ada, {
      notice: { kind: "routine_handoff", text: "3 erros novos", refs: { routineName: "Sentry diário" } },
    });
    const told = msg("told", 1, ada, { routine: { id: "rt", name: "Sentry diário", runId: "rr", noticeId: "notice" } });
    const other = msg("other", 2, ada, { notice: { kind: "routine_handoff", text: "outro" } });
    expect([...answeredNotices([report, told, other])]).toEqual(["notice"]);
    const shown = buildTimeline([report, told, other], [], []).flatMap((i) =>
      i.kind === "message" ? [i.message.id] : [],
    );
    // The answered report is gone; the one nobody answered stays a line; the answer shows on its own.
    expect(shown).toEqual(["told", "other"]);
    // The notice's own text when the message has no body; its body otherwise.
    expect(routineReportText([report, told], "notice")).toBe("notice");
    expect(routineReportText([{ ...report, body: "" }], "notice")).toBe("3 erros novos");
    expect(routineReportText([report], "missing")).toBeNull();
    expect(routineReportText([told], "told")).toBeNull();
    expect(routineReportText([report], null)).toBeNull();
    // A person's message never answers a report (only the agent's, with `meta.routine`).
    const byPerson = msg("p", 3, walter, { routine: { id: "rt", name: "x", noticeId: "notice" } });
    expect(answeredNotices([byPerson]).size).toBe(0);
  });

  test("a follow-up's line: cancelable while it waits, its day when not today, past once it came, canceled", () => {
    const at = "2026-10-30T14:00:00.000Z";
    const today = new Date("2026-10-30T13:00:00.000Z");
    const dayBefore = new Date("2026-10-29T13:00:00.000Z");
    const when = { time: (iso: string) => (iso === at ? "11:00" : "?"), locale: "pt-BR" };
    const line = (refs: Record<string, string>, now = today) => {
      const notice = noticeOf({ notice: { kind: "follow_up", text: "Check CI run 42", refs } });
      return notice ? followUpLine(notice, "Ari", when, now) : null;
    };
    const refs = { runId: "r1", at, about: "ver o CI" };
    expect(line({ ...refs, state: "pending" })).toEqual({
      key: "chat.notice.followUp",
      values: { name: "Ari", about: "ver o CI", time: "11:00", day: "" },
      pending: true,
    });
    // Set the day before: it says the day it comes back.
    expect(line({ ...refs, state: "pending" }, dayBefore)).toEqual({
      key: "chat.notice.followUpOn",
      values: { name: "Ari", about: "ver o CI", time: "11:00", day: formatShortDate("pt-BR", at) },
      pending: true,
    });
    expect(line({ ...refs, state: "done" })).toMatchObject({ key: "chat.notice.followUpDone", pending: false });
    expect(line({ ...refs, state: "done" }, dayBefore)?.key).toBe("chat.notice.followUpDoneOn");
    expect(line({ ...refs, state: "canceled" })).toMatchObject({ key: "chat.notice.followUpCanceled", pending: false });
    expect(line({ ...refs, state: "canceled" }, dayBefore)?.key).toBe("chat.notice.followUpCanceledOn");
    expect(line({ ...refs, wake: "1", followUpId: "m1" })).toMatchObject({
      key: "chat.notice.followUpWake",
      pending: false,
    });
    const report = noticeOf({ notice: { kind: "routine_handoff", text: "x", refs: {} } });
    expect(report && followUpLine(report, "Ari", when)).toBeNull();
  });
});

describe("consultationOfNotice", () => {
  const notice = (refs: Record<string, string>) => ({
    notice: { kind: "consult_reply", text: "written for the asking agent", from: "@infra", refs },
  });

  test("another agent's answer with its consultation: who asked whom, the question and the answer", () => {
    const meta = notice({
      consultationId: "c1",
      runId: "r1",
      askerAgentId: "dev",
      agentId: "infra",
      status: "answered",
      question: "Onde fica o deploy?",
      answer: "No deploy.sh",
    });
    expect(consultationOfNotice(meta)).toEqual({
      askerId: "dev",
      consultation: {
        agentId: "infra",
        consultationId: "c1",
        status: "answered",
        question: "Onde fica o deploy?",
        answer: "No deploy.sh",
      },
    });
  });

  test("an older notice without them, another kind or an unknown status stays a line", () => {
    expect(consultationOfNotice(notice({ consultationId: "c1", runId: "r1" }))).toBeNull();
    expect(
      consultationOfNotice(notice({ askerAgentId: "dev", agentId: "infra", status: "pending", question: "Onde?" })),
    ).toBeNull();
    expect(consultationOfNotice({ notice: { kind: "agent_note", text: "x", refs: { question: "q" } } })).toBeNull();
    expect(consultationOfNotice(undefined)).toBeNull();
  });

  test("no answer yet (expired): the answer is null", () => {
    const meta = notice({ askerAgentId: "dev", agentId: "infra", status: "expired", question: "Onde?" });
    expect(consultationOfNotice(meta)?.consultation.answer).toBeNull();
  });

  test("what came of work handed off says so: its card words it as a request", () => {
    const meta = notice({
      kind: "note",
      askerAgentId: "dev",
      agentId: "infra",
      status: "failed",
      question: "Limpa a fila.",
    });
    expect(consultationOfNotice(meta)?.consultation).toMatchObject({ kind: "note", status: "failed" });
    expect(
      consultationOfNotice(notice({ askerAgentId: "dev", agentId: "infra", status: "failed", question: "Q?" }))
        ?.consultation.kind,
    ).toBeUndefined();
  });
});
