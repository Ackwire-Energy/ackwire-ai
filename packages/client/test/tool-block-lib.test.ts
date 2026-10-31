import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { LiveWork } from "../src/index";
import { applyChannelEvent, emptyStreams } from "../src/index";
import { type Activity, barEntries } from "../src/lib/activity";
import {
  callLogo,
  formatLineTime,
  type ToolItem,
  toolApps,
  toolCalls,
  toolHint,
  toolItemsLive,
  toolItemsSaved,
  toolNow,
  toolPhrase,
  workApps,
  workFromSteps,
  workMeta,
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

  test("a reaction shows on the message, never in the block: alone there is no call; with others, only they count", () => {
    expect(toolItemsLive([call("1", "react")])).toEqual([]);
    const items = toolItemsLive([call("1", "mcp__agentes__react"), call("2", "create_issue")]);
    expect(items.map((i) => (i.kind === "call" ? `${i.line.kind}×${i.line.count}` : i.kind))).toEqual([
      "creatingIssue×1",
    ]);
    expect(toolCalls(items)).toBe(1);
    const at = (s: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, s)).toISOString();
    const saved = workFromSteps([
      { seq: 1, kind: "tool_call", data: { toolUseId: "t1", name: "react", input: { emoji: "🙌" } }, createdAt: at(0) },
      { seq: 2, kind: "tool_result", data: { toolUseId: "t1", content: "Reaction added." }, createdAt: at(1) },
      { seq: 3, kind: "tool_call", data: { toolUseId: "t2", name: "create_issue", input: {} }, createdAt: at(2) },
      { seq: 4, kind: "tool_result", data: { toolUseId: "t2", content: "ok" }, createdAt: at(3) },
    ]);
    expect(toolCalls(toolItemsSaved(saved))).toBe(1);
    expect(saved.steps.map((s) => s.kind)).toEqual(["creatingIssue"]);
  });

  test("looking up a tool on demand is ours, not an app called find", () => {
    const items = toolItemsLive([call("1", "find_tools"), call("2", "github_find_tools", { connector: "GitHub" })]);
    expect(items.map((i) => (i.kind === "call" ? `${i.line.kind}×${i.line.count}` : i.kind))).toEqual([
      "findingTools×2",
    ]);
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

describe("each call's service and its logo", () => {
  const catalog = [
    { id: "github", label: "GitHub", iconUrl: "/connectors/github.svg", brandColor: null },
    { id: "drive", label: "Google Drive", iconUrl: "/connectors/googledrive.svg", brandColor: "#4285F4" },
    { id: "linear", label: "Linear", iconUrl: "/connectors/linear.svg", brandColor: "#5E6AD2" },
  ];
  const icon =
    "/api/app/connector-icons/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000f1/0123456789abcdef.png";
  const lines = (items: ToolItem[]) => items.flatMap((i) => (i.kind === "call" ? [i.line] : []));
  const logo = (a: Activity | undefined) => (a ? callLogo(a, catalog) : null);

  test("a mailbox goes by its maker: Gmail's mark, 'Consultou o Gmail', only the verb in grey", () => {
    const [gmail, other, old] = lines(
      toolItemsLive([
        call("1", "mail_wnogueira_search", { connector: "Email", service: "gmail" }),
        { kind: "say", text: "Agora a outra caixa." },
        call("2", "mail_contato_read", { connector: "Email", service: "custom" }),
        { kind: "say", text: "E a de antes." },
        call("3", "mail_ana_read", { connector: "Email" }),
      ]),
    );
    expect(gmail).toMatchObject({ kind: "consulting", app: "Gmail", service: "gmail", hint: "search" });
    expect(gmail && toolPhrase(t, { ...gmail, state: "done" })).toBe(
      'chat.work.step.consulting|{"app":"Gmail","tool":"mail wnogueira search"}',
    );
    expect(logo(gmail)).toMatchObject({
      kind: "service",
      def: { iconUrl: "/connectors/gmail.svg", brandColor: "#EA4335" },
      image: null,
      label: "Gmail",
    });
    // A mailbox on a server of its own, or one recorded before calls named their service: our envelope, "Email".
    expect(other).toMatchObject({ app: "Email", service: "mail", hint: "read" });
    expect(old).toMatchObject({ app: "Email", service: "mail", hint: "read" });
    expect(logo(other)).toEqual({ kind: "mail" });
    // A maker's name keeps its own capitals; a connector's slug gets one.
    const [icloud] = lines(toolItemsLive([call("4", "mail_contato_read", { connector: "Email", service: "icloud" })]));
    expect(icloud && toolPhrase(t, { ...icloud, state: "done" })).toBe(
      'chat.work.step.consulting|{"app":"iCloud","tool":"mail contato read"}',
    );
    expect(toolPhrase(t, { kind: "consulting", app: "himetrica", tool: "himetrica_get", state: "done" })).toBe(
      'chat.work.step.consulting|{"app":"Himetrica","tool":"himetrica get"}',
    );
  });

  test("a connector shows its mark, a server by address its own icon, a database Postgres's; ours keep our icons", () => {
    const [github, custom, db, issue, ownDrive, googleDrive] = lines(
      toolItemsLive([
        call("1", "github_search_issues", { connector: "GitHub", service: "github" }),
        call("2", "acme_tools_find_orders", { connector: "Acme Tools", serviceIcon: icon }),
        call("3", "pg_analytics_list_tables", { connector: "Analytics", service: "postgres" }),
        call("4", "create_issue"),
        call("5", "read_artifact"),
        call("6", "drive_search_files", { connector: "Google Drive", service: "drive" }),
      ]),
    );
    expect(logo(github)).toMatchObject({
      kind: "service",
      def: { iconUrl: "/connectors/github.svg" },
    });
    expect(github?.hint).toBe("search issues");
    // A server's whole label leaves its tools' names, however many words it has.
    expect(custom?.hint).toBe("find orders");
    expect(logo(custom)).toEqual({
      kind: "service",
      def: null,
      image: icon,
      label: "Acme Tools",
    });
    expect(db).toMatchObject({ app: "Analytics", hint: "list tables" });
    expect(logo(db)).toMatchObject({
      kind: "service",
      def: { iconUrl: "/brands/postgresql.svg" },
    });
    expect(logo(issue)).toEqual({ kind: "own" });
    // Our Drive is ours; Google Drive's calls read the same but show its mark.
    expect([ownDrive?.kind, googleDrive?.kind]).toEqual(["readingDrive", "readingDrive"]);
    expect(logo(ownDrive)).toEqual({ kind: "own" });
    expect(logo(googleDrive)).toMatchObject({
      def: { iconUrl: "/connectors/googledrive.svg" },
    });
  });

  test("the block's logos: each service once, in order of first use, four at most", () => {
    const items = toolItemsLive([
      call("1", "mail_wnogueira_search", { connector: "Email", service: "gmail" }),
      call("2", "github_get_pr", { connector: "GitHub", service: "github" }),
      call("3", "mail_wnogueira_read", { connector: "Email", service: "gmail" }),
      call("4", "create_issue"),
      call("5", "read_artifact"),
      call("6", "linear_list_issues", { connector: "Linear", service: "linear" }),
    ]);
    expect(toolApps(items)).toEqual([
      { kind: "consulting", app: "Gmail", service: "gmail" },
      { kind: "consulting", app: "GitHub", service: "github" },
      { kind: "creatingIssue" },
      { kind: "readingDrive" },
    ]);
  });

  test("a saved run reads its app and service from the step; the reply's meta gives the closed block's logos", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, s)).toISOString();
    const work = workFromSteps([
      {
        seq: 1,
        kind: "tool_call",
        data: { toolUseId: "t1", name: "mail_wnogueira_search", input: {}, connector: "Email", service: "gmail" },
        createdAt: at(0),
      },
      { seq: 2, kind: "tool_result", data: { toolUseId: "t1", content: "2 messages" }, createdAt: at(1) },
      {
        seq: 3,
        kind: "tool_call",
        data: { toolUseId: "t2", name: "open_pull_request", input: {}, connector: "GitHub", service: "github" },
        createdAt: at(2),
      },
      { seq: 4, kind: "tool_result", data: { toolUseId: "t2", content: "opened" }, createdAt: at(3) },
    ]);
    expect(work.steps.map((s) => [s.app, s.service, s.hint])).toEqual([
      ["Gmail", "gmail", "search"],
      ["GitHub", "github", "open pull request"],
    ]);
    const meta = workMeta({
      work: {
        steps: 3,
        durationMs: 4000,
        calls: [
          { name: "mail_wnogueira_search", connector: "Email", service: "gmail" },
          { name: "create_issue" },
          { tool: "no name" },
          { name: "github_get_pr", connector: "GitHub", service: "github" },
        ],
      },
    });
    expect(meta?.calls.map((c) => c.name)).toEqual(["mail_wnogueira_search", "create_issue", "github_get_pr"]);
    expect(workApps(meta?.calls ?? [])).toEqual([
      { kind: "consulting", app: "Gmail", service: "gmail" },
      { kind: "creatingIssue" },
      { kind: "consulting", app: "GitHub", service: "github" },
    ]);
    // Older replies carry only the count: no logos until the steps load.
    expect(workMeta({ work: { steps: 2 } })?.calls).toEqual([]);
  });

  test("the bar names the mailbox's maker too", () => {
    const run = {
      runId: "r1",
      agentId: "theo",
      channelId: "c1",
      threadId: "m1",
      status: "running" as const,
      text: "",
      lastSeq: 0,
      tool: "mail_wnogueira_search",
      connector: "Email",
      service: "gmail",
    };
    expect(
      barEntries(
        [run],
        [],
        () => "Theo",
        () => undefined,
      )[0]?.activity,
    ).toEqual({
      kind: "consulting",
      app: "Gmail",
      service: "gmail",
    });
  });
});
