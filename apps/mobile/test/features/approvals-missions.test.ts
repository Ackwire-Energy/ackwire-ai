import { describe, expect, test } from "bun:test";
import type { MachineTask } from "@agenteschat/client";
import {
  approvalAction,
  approvalRisk,
  approvalSaid,
  approvalTable,
  approvalTraits,
  approveAlwaysHint,
  approveAlwaysOffered,
  approveAlwaysToast,
  waitingApprovals,
} from "../../src/features/approvals/logic";
import {
  hoursSince,
  liveSessions,
  missionTrack,
  planProgress,
  planRows,
  recommendedOption,
  takenDecisions,
  trackCells,
  waitingCards,
  waitingCount,
} from "../../src/features/missions/logic";
import { approval, decision, mission, translator } from "./fixtures";

describe("requests to approve", () => {
  test("deploys, deletes and sends take a hold; merges are a tap", () => {
    expect(approvalRisk({ tool: "github_merge_pull_request", scope: "github:pulls.merge" })).toBe("normal");
    expect(approvalRisk({ tool: "deploy_production", scope: "vercel:deploy" })).toBe("high");
    expect(approvalRisk({ tool: "send_campaign", scope: "mail:send" })).toBe("high");
    expect(approvalRisk({ tool: "delete_file", scope: "drive:write" })).toBe("high");
    expect(approvalAction({ tool: "post_message", scope: "slack:post_message" })).toBe("other");
  });

  test("a mailbox's scope says what a mail tool does: a draft is a tap, nothing leaves", () => {
    const draft = { tool: "mail_support_draft", scope: "mail:draft", params: {} };
    expect(approvalAction(draft)).toBe("draft");
    expect(approvalRisk(draft)).toBe("normal");
    expect(approvalTraits(draft)).toEqual(["unsent", "deletable"]);
    expect(approvalRisk({ tool: "mail_support_archive", scope: "mail:organize" })).toBe("normal");
    expect(approvalRisk({ tool: "mail_support_reply", scope: "mail:send" })).toBe("high");
    expect(approvalAction({ tool: "mail_support_trash", scope: "mail:delete" })).toBe("delete");
  });

  test("what it touches, in plain words", () => {
    expect(approvalTraits({ tool: "deploy", scope: "x", params: {} })).toEqual(["production", "reversible"]);
    expect(approvalTraits({ tool: "send_email", scope: "mail", params: {} })).toEqual(["irreversible", "external"]);
    expect(approvalTraits({ tool: "update", scope: "x", params: { env: "production" } })).toEqual(["production"]);
  });

  test("waiting on you: pending, yours to decide, not expired, closest to expiring first", () => {
    const now = Date.now();
    const soon = approval({ id: "soon", expiresAt: new Date(now + 5 * 60_000).toISOString() });
    const later = approval({ id: "later", expiresAt: new Date(now + 50 * 60_000).toISOString() });
    const notMine = approval({ id: "nm", canDecide: false });
    const gone = approval({ id: "gone", expiresAt: new Date(now - 60_000).toISOString() });
    const done = approval({ id: "done", status: "approved" });
    expect(waitingApprovals([later, notMine, soon, gone, done], now).map((a) => a.id)).toEqual(["soon", "later"]);
  });
});

describe("Aprovar sempre on the phone", () => {
  const offered = approval({
    id: "always",
    tool: "composio_COMPOSIO_MULTI_EXECUTE_TOOL",
    scope: "custom:c1:write",
    approveAlways: { tool: "COMPOSIO_MULTI_EXECUTE_TOOL", actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"] },
  });

  test("the quiet third button: only where the server offers it, to who decides, never on a hold", () => {
    expect(approveAlwaysOffered(offered)).toBe(true);
    expect(approveAlwaysOffered({ ...offered, canDecide: false })).toBe(false);
    expect(approveAlwaysOffered({ ...offered, approveAlways: null })).toBe(false);
    expect(approveAlwaysOffered({ ...offered, approveAlways: undefined })).toBe(false);
    expect(approveAlwaysOffered({ ...offered, status: "approved" })).toBe(false);
    // High risk takes a hold, never a tap: it isn't approved for good.
    expect(approveAlwaysOffered({ ...offered, tool: "deploy_production", scope: "vercel:deploy" })).toBe(false);
  });

  test("under the button, before the tap: what it approves for good, with any values, in both languages", async () => {
    expect(approveAlwaysHint(await translator("pt-BR"), offered, "Ada")).toBe(
      "Aprova este e os próximos iguais da Ada: Criar comentário da issue (Github), com qualquer valor.",
    );
    expect(approveAlwaysHint(await translator("en"), offered, "Theo")).toBe(
      "Approves this one and the next ones like it from Theo: Create issue comment (Github), with any values.",
    );
  });

  test("its toast: it won't ask again, and where to undo it, in both languages", async () => {
    const pt = await translator("pt-BR");
    expect(approveAlwaysToast(pt, "Ada")).toEqual({
      title: "Aprovado. Ada não pede mais para isso.",
      subtitle: "Para desfazer, abra a página dela na web, em Ferramentas e acesso.",
    });
    expect(approveAlwaysToast(pt, "Theo").subtitle).toBe(
      "Para desfazer, abra a página dele na web, em Ferramentas e acesso.",
    );
    expect(approveAlwaysToast(await translator("en"), "Ada")).toEqual({
      title: "Approved. Ada won't ask for this again.",
      subtitle: "To undo it, open her page on the web, in Tools and access.",
    });
  });
});

describe("missions", () => {
  const items = [
    { id: "1", title: "Ler o app web", status: "done" as const },
    { id: "2", title: "Login", status: "done" as const },
    { id: "3", title: "Tela Início", status: "doing" as const },
    { id: "4", title: "Pergunta", status: "waiting_you" as const },
    { id: "5", title: "Fora", status: "dropped" as const },
    { id: "6", title: "Testes", status: "todo" as const },
  ];

  test("the plan as cells (dropped left out, waiting moves)", () => {
    expect(trackCells(items)).toEqual(["done", "done", "run", "run", "todo"]);
    expect(planRows(items).map((i) => i.id)).toEqual(["1", "2", "3", "4", "6"]);
  });

  test("progress from the items, or from the counts on older servers", () => {
    const m = mission({ id: "m", plan: { version: 1, done: 2, total: 5, waiting: 1, doing: 1, items } });
    expect(missionTrack(m)).toEqual(["done", "done", "run", "run", "todo"]);
    expect(planProgress(m)).toEqual({ done: 2, total: 5 });
    const counts = mission({
      id: "m",
      runningTasks: 1,
      plan: { version: 1, done: 5, total: 12, waiting: 0, doing: 1, items: [] },
    });
    expect(missionTrack(counts)).toEqual([...Array(5).fill("done"), "run", ...Array(6).fill("todo")]);
    expect(planProgress(counts)).toEqual({ done: 5, total: 12 });
  });

  test("what waits on you counts only when you may act", () => {
    const pending = { decisions: 1, provisional: 0, reviews: 1, suggestions: 3, joinRequests: 0, commands: 0 };
    expect(waitingCount(mission({ id: "m", pending }))).toBe(2);
    expect(waitingCount(mission({ id: "m", pending, canAct: false }))).toBe(0);
  });

  test("decisions: waiting ones, taken ones newest first, the recommended option", () => {
    const list = [
      decision({ id: "p" }),
      decision({ id: "t1", status: "taken", chosen: "Início", chosenAt: "2026-10-12T10:00:00.000Z" }),
      decision({ id: "t2", status: "taken", chosen: "Expo", chosenAt: "2026-10-14T10:00:00.000Z" }),
      decision({ id: "t0", status: "taken", chosen: null }),
    ];
    expect(waitingCards([], list).decisions.map((d) => d.id)).toEqual(["p"]);
    expect(takenDecisions(list).map((d) => d.id)).toEqual(["t2", "t1"]);
    expect(recommendedOption(decision({ id: "x" }))).toBe("Início");
    expect(recommendedOption(decision({ id: "x", recommendation: "Outra" }))).toBeNull();
  });

  test("sessions on the computer now, and hours of work", () => {
    const task = (id: string, status: MachineTask["status"], missionId = "m1") =>
      ({
        id,
        status,
        missionId,
        startedAt: "2026-10-17T10:00:00.000Z",
        createdAt: "2026-10-17T10:00:00.000Z",
      }) as MachineTask;
    expect(
      liveSessions([task("a", "running"), task("b", "done"), task("c", "running", "m2")], "m1").map((t) => t.id),
    ).toEqual(["a"]);
    expect(hoursSince(null)).toBeNull();
    expect(hoursSince("2026-10-17T00:00:00.000Z", Date.parse("2026-10-17T14:30:00.000Z"))).toBe(14);
  });
});

describe("the exact request", () => {
  test("the details table: where it goes first, then the values, at most three rows", () => {
    const a = approval({
      id: "ap",
      connector: "github",
      connectorAccount: "acme/app",
      params: { pull_number: 128, base: "main", method: "squash", extra: "x" },
    });
    expect(approvalTable(a, 3, (id) => (id === "github" ? "GitHub" : id))).toEqual([
      { label: null, value: "GitHub · acme/app" },
      { label: "Pull number", value: "128" },
      { label: "Base", value: "main" },
    ]);
    expect(approvalTable(approval({ id: "b", params: { title: "Oi" } }))).toEqual([{ label: "Title", value: "Oi" }]);
  });

  test("a tool run by name: its arguments in words, without the name; objects one level in", () => {
    const a = approval({
      id: "s",
      connector: "custom:sentry",
      params: { name: "get_event_stacktrace", arguments: { issueId: "ACME-177", eventId: "abc" }, files: ["a"] },
    });
    expect(approvalTable(a, 6)).toEqual([
      { label: null, value: "custom:sentry" },
      { label: "Issue id", value: "ACME-177" },
      { label: "Event id", value: "abc" },
    ]);
    const long = "x".repeat(80);
    expect(approvalTable(approval({ id: "l", params: { query: long } }))).toEqual([]);
    expect(approvalTable(approval({ id: "l", params: { query: long } }), 6, undefined, true)).toEqual([
      { label: "Query", value: long },
    ]);
  });

  test("what the agent said before: its why, else the last turn", () => {
    expect(approvalSaid(approval({ id: "a", why: " Os testes passaram. " }))).toBe("Os testes passaram.");
    expect(
      approvalSaid(
        approval({
          id: "b",
          why: null,
          trail: [
            { text: "Primeiro", at: "2026-10-18T10:00:00Z" },
            { text: "Por último", at: "2026-10-18T10:01:00Z" },
          ],
        }),
      ),
    ).toBe("Por último");
    expect(approvalSaid(approval({ id: "c", why: null }))).toBeNull();
  });
});
