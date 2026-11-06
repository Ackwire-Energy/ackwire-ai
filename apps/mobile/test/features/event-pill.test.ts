import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stoppedRunsKey, stoppedRunsOf } from "../../src/features/chat/stopped-runs";
import { message } from "./fixtures";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

const ada = { type: "agent" as const, id: "ada" };
const notice = (id: string, runId: string, reason: string | null = null) =>
  message({
    id,
    author: ada,
    meta: {
      notice: {
        kind: "run_stopped",
        text: "stopped",
        refs: { runId, byUserId: "me", byName: "Ana", label: "Fix the CI", was: "working", reason },
      },
    },
  });
const reply = (id: string, runId: string, meta: Record<string, unknown> = { canceled: { byUserId: "me" } }) =>
  message({ id, author: ada, agentRunId: runId, meta });

describe("one stop, one pill", () => {
  test("a stop notice whose stopped reply is here goes into that reply's pill", () => {
    const runs = stoppedRunsOf([reply("m1", "r1"), notice("n1", "r1", "wrong repo")]);
    expect([...runs.keys()]).toEqual(["r1"]);
    expect(runs.get("r1")?.notice).toMatchObject({ byUserId: "me", byName: "Ana", reason: "wrong repo" });
    expect(runs.get("r1")?.message.id).toBe("n1");
  });

  test("stopped while queued (no reply), or a reply that wasn't stopped: the notice keeps its own pill", () => {
    expect(stoppedRunsOf([notice("n1", "r1")]).size).toBe(0);
    expect(stoppedRunsOf([reply("m1", "r1", {}), notice("n1", "r1")]).size).toBe(0);
    // Media an agent posts after its reply carries the run too, but is never the reply.
    expect(stoppedRunsOf([reply("m2", "r1", { canceled: {}, mediaAfter: "m1" }), notice("n1", "r1")]).size).toBe(0);
    // A reply with no notice here has nothing to merge.
    expect(stoppedRunsOf([reply("m1", "r1")]).size).toBe(0);
  });

  test("the rows redraw when a reason is said, not on every message", () => {
    const before = stoppedRunsKey(stoppedRunsOf([reply("m1", "r1"), notice("n1", "r1")]));
    const person = message({ id: "x", author: { type: "person", id: "me" } });
    const more = stoppedRunsKey(stoppedRunsOf([reply("m1", "r1"), notice("n1", "r1"), person]));
    const said = stoppedRunsKey(stoppedRunsOf([reply("m1", "r1"), notice("n1", "r1", "why")]));
    expect(more).toBe(before);
    expect(said).not.toBe(before);
  });

  test("the conversation's list provides the stops; the notice draws nothing while its reply has them", () => {
    expect(src("features/chat/ChatScreen.tsx")).toContain("<StoppedRunsContext.Provider value={stoppedRuns}>");
    const line = src("features/chat/StoppedLine.tsx");
    expect(line).toContain("const inReply = useStoppedRun(notice.runId);\n  if (inReply) return null;");
    expect(line).not.toContain("taskManager.stopped.told");
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain("const stop = useStoppedRun(limit ? null : runId);");
    expect(row).toContain("<StopPill");
  });
});

describe("the event pill", () => {
  test("a hairline frame with the cut corner, no fill; actions after hairlines; what opens text is an action", () => {
    const pill = src("ui/EventPill.tsx");
    expect(pill).toContain("borderBottomLeftRadius: CUT");
    expect(pill).not.toMatch(/frame: \{[^}]*backgroundColor/);
    expect(pill).toContain('<Icon name="right" size={12} color={c.faint} />');
    expect(pill).toContain('turned: { transform: [{ rotate: "90deg" }] }');
    expect(src("ui/index.ts")).toContain('} from "./EventPill";');
  });

  test("the automatic lines use it: notices, stops, decided requests, the task taken, the speed fallback", () => {
    for (const file of [
      "features/chat/EventLine.tsx",
      "features/chat/StoppedLine.tsx",
      "features/chat/asks.tsx",
      "features/chat/issue-work.tsx",
    ])
      expect(src(file)).toContain("<EventPill");
    // No more " · " chains with the time in the notice line; "Cancel" on a follow-up still to come.
    const line = src("features/chat/EventLine.tsx");
    expect(line).toContain("time={when.time(message.createdAt)}");
    expect(line).toContain('t("chat.notice.followUpCancel")');
    expect(line).not.toContain('" · "');
  });

  test("a decided approval: outcome and title, its date in the time slot, Cancel as an action, the values under it", () => {
    const cards = src("features/chat/cards.tsx");
    const done = cards.slice(cards.indexOf("function ApprovalDone("), cards.indexOf("function ApprovalGroupAsk("));
    expect(done).toContain("words={`${outcome}: ${markName(approvalHeadline(t, a, i18n.language))}`}");
    expect(done).toContain("time={a.decidedAt ? when.short(a.decidedAt) : undefined}");
    expect(done).toContain('label={t("approval.ahead.cancel")}');
    expect(done).toContain("approvalSummary(a, i18n.language)");
  });
});
