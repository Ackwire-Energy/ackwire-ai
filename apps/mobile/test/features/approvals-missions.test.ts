import { describe, expect, test } from "bun:test";
import type { MachineTask } from "@agenteschat/client";
import {
  approvalAction,
  approvalFacts,
  approvalRisk,
  approvalTraits,
  humanKey,
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
import { approval, decision, mission } from "./fixtures";

describe("requests to approve", () => {
  test("deploys, deletes and sends take a hold; merges are a tap", () => {
    expect(approvalRisk({ tool: "github_merge_pull_request", scope: "github:pulls.merge" })).toBe("normal");
    expect(approvalRisk({ tool: "deploy_production", scope: "vercel:deploy" })).toBe("high");
    expect(approvalRisk({ tool: "send_campaign", scope: "mail:send" })).toBe("high");
    expect(approvalRisk({ tool: "delete_file", scope: "drive:write" })).toBe("high");
    expect(approvalAction({ tool: "post_message", scope: "slack:post_message" })).toBe("other");
  });

  test("what it touches, in plain words", () => {
    expect(approvalTraits({ tool: "deploy", scope: "x", params: {} })).toEqual(["production", "reversible"]);
    expect(approvalTraits({ tool: "send_email", scope: "mail", params: {} })).toEqual(["irreversible", "external"]);
    expect(approvalTraits({ tool: "update", scope: "x", params: { env: "production" } })).toEqual(["production"]);
  });

  test("the exact values, as facts", () => {
    expect(approvalFacts({ pull_number: 42, repo: "agentes", draft: false, files: ["a"], empty: " " })).toEqual([
      ["Pull number", "42"],
      ["Repo", "agentes"],
      ["Draft", "false"],
    ]);
    expect(humanKey("baseBranch")).toBe("Base branch");
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
