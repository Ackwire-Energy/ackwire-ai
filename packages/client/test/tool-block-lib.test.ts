import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { LiveWork } from "../src/index";
import { applyChannelEvent, emptyStreams } from "../src/index";
import {
  formatLineTime,
  toolApps,
  toolCalls,
  toolHint,
  toolItemsLive,
  toolItemsSaved,
  toolNow,
  toolPhrase,
  workFromSteps,
} from "../src/lib/work";

type Ev = Parameters<typeof applyChannelEvent>[1];
const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
const start = (toolUseId: string, tool: string, extra: Record<string, unknown> = {}) =>
  ({ type: "agent.tool", ...base, tool, toolUseId, ...extra }) as Ev;
const end = (toolUseId?: string, failed?: boolean) =>
  ({
    type: "agent.tool",
    ...base,
    tool: null,
    ...(toolUseId ? { toolUseId } : {}),
    ...(failed ? { failed } : {}),
  }) as Ev;
const calls = (work: LiveWork[] | undefined) =>
  (work ?? []).flatMap((w) => (w.kind === "call" ? [{ id: w.id, running: w.running, failed: w.failed === true }] : []));

/** "key|{values}": which words, with what. */
const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key}|${JSON.stringify(o)}` : key)) as TFunction;

describe("the live calls", () => {
  test("the end names its call and says whether it failed; each ended call has its time", () => {
    let s = [start("a", "github_search_issues", { connector: "GitHub" }), start("b", "create_issue")].reduce(
      applyChannelEvent,
      emptyStreams,
    );
    // A new call ended the one before.
    expect(calls(s.runs.r1?.work)).toEqual([
      { id: "a", running: false, failed: false },
      { id: "b", running: true, failed: false },
    ]);
    s = applyChannelEvent(s, end("b", true));
    expect(calls(s.runs.r1?.work)).toEqual([
      { id: "a", running: false, failed: false },
      { id: "b", running: false, failed: true },
    ]);
    const ended = (s.runs.r1?.work ?? []).filter((w) => w.kind === "call");
    for (const w of ended) expect(typeof (w as { ms?: number }).ms).toBe("number");
  });

  test("a call that waits on a person never reads as done", () => {
    let s = [start("a", "gmail_send_email", { connector: "Gmail" })].reduce(applyChannelEvent, emptyStreams);
    s = applyChannelEvent(s, { ...end("a"), held: true } as Ev);
    const items = toolItemsLive(s.runs.r1?.work ?? []);
    expect(items.map((i) => (i.kind === "call" ? i.line.state : i.kind))).toEqual(["stop"]);
  });

  test("an end without an id still stops the last running call (older servers)", () => {
    let s = [start("a", "create_issue")].reduce(applyChannelEvent, emptyStreams);
    s = applyChannelEvent(s, end());
    expect(calls(s.runs.r1?.work)).toEqual([{ id: "a", running: false, failed: false }]);
  });
});

const call = (id: string, tool: string, extra: Partial<Extract<LiveWork, { kind: "call" }>> = {}): LiveWork => ({
  kind: "call",
  id,
  tool,
  connector: null,
  detail: null,
  code: null,
  output: [],
  running: false,
  ms: 100,
  ...extra,
});

describe("the block's lines", () => {
  test("the same kind in a row is one line counting each; a failure or something said keeps them apart", () => {
    const items = toolItemsLive([
      call("1", "browser_open"),
      call("2", "browser_click"),
      call("3", "browser_click", { failed: true }),
      { kind: "say", text: "Vou tentar de novo." },
      call("4", "browser_click", { running: true, ms: undefined }),
    ]);
    expect(items.map((i) => (i.kind === "call" ? `${i.line.state}×${i.line.count}` : i.kind))).toEqual([
      "done×2",
      "fail×1",
      "say",
      "run×1",
    ]);
    expect(toolCalls(items)).toBe(4);
    expect(toolNow(items)?.key).toBe("4");
  });

  test("a stopped run shows its running call as stopped; messages it read are their own items", () => {
    const items = toolItemsLive(
      [call("1", "create_issue", { running: true }), { kind: "steer", messageId: "m9" }],
      true,
    );
    expect(items.map((i) => (i.kind === "call" ? i.line.state : i.kind))).toEqual(["stop", "steer"]);
  });

  test("logos: each app once, in order of first use; our tools by kind", () => {
    const items = toolItemsLive([
      call("1", "github_search_issues", { connector: "GitHub" }),
      call("2", "create_issue"),
      call("3", "github_get_issue", { connector: "GitHub" }),
    ]);
    expect(toolApps(items)).toEqual([{ kind: "consulting", app: "GitHub" }, { kind: "creatingIssue" }]);
  });

  test("grey words: a built-in's label, or a connector tool's own name without its app; never its input", () => {
    expect(toolHint("create_issue", { kind: "creatingIssue" }, "Corrigir login")).toBe("Corrigir login");
    expect(toolHint("create_issue", { kind: "creatingIssue" })).toBeNull();
    expect(toolHint("github_search_issues", { kind: "consulting", app: "GitHub" })).toBe("search issues");
    expect(toolHint("mcp__linear__get_project", { kind: "consulting", app: "Linear" })).toBe("get project");
  });

  test("phrases: working, done, failed, stopped", () => {
    const l = { kind: "consulting" as const, app: "GitHub", tool: "github_search_issues" };
    expect(toolPhrase(t, { ...l, state: "run" })).toBe('Chat.activity.consulting|{"app":"GitHub"}…');
    expect(toolPhrase(t, { ...l, state: "done" })).toBe(
      'chat.work.step.consulting|{"app":"GitHub","tool":"github search issues"}',
    );
    expect(toolPhrase(t, { ...l, state: "fail" })).toBe(
      'chat.work.erred|{"activity":"chat.activity.consulting|{\\"app\\":\\"GitHub\\"}"}',
    );
    expect(formatLineTime("pt-BR", 1200)).toBe("1,2 s");
    expect(formatLineTime("pt-BR", 760)).toBe("760 ms");
  });

  test("a saved run: the label it was recorded with, why it failed, what it got and gave", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 27, 10, 0, s)).toISOString();
    const work = workFromSteps([
      {
        seq: 1,
        kind: "tool_call",
        data: { toolUseId: "t1", name: "create_issue", input: { title: "X" }, detail: "X" },
        createdAt: at(0),
      },
      {
        seq: 2,
        kind: "tool_result",
        data: { toolUseId: "t1", isError: true, content: "timed out after 5s\nstack" },
        createdAt: at(2),
      },
    ]);
    const [item] = toolItemsSaved(work);
    expect(item?.kind === "call" && item.line).toMatchObject({
      state: "fail",
      hint: "X",
      why: "timed out after 5s",
      ms: 2000,
      result: "timed out after 5s\nstack",
    });
    expect(item?.kind === "call" && item.line.input).toContain('"title": "X"');
  });
});
