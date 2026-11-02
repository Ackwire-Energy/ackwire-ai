import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EndedTask, ManagedTask } from "@agenteschat/client";
import { taskProgram, taskTitle } from "@agenteschat/client/lib/task-manager";
import {
  agentTasksHref,
  agentTasksOf,
  doneTodayOf,
  endedLatestFirst,
  endedText,
  groupLine,
  isHere,
  rowState,
  stateText,
  tasksBadge,
  taskSubline,
  usingNow,
} from "../../src/features/task-manager/logic";
import { translator } from "./fixtures";

const APP = join(import.meta.dir, "../../app/(app)");

const task = (over: Partial<ManagedTask> & { runId: string }): ManagedTask => ({
  agentId: "dev",
  channelId: "dm1",
  channelKind: "dm",
  channelName: null,
  threadId: null,
  status: "running",
  startedAt: null,
  createdAt: "2026-11-02T14:00:00.000Z",
  label: null,
  background: false,
  routine: null,
  plan: null,
  requester: null,
  brain: "model",
  machine: null,
  now: null,
  steps: 0,
  pendingMessageIds: [],
  canStop: true,
  ...over,
});

const ended = (over: Partial<EndedTask> & { runId: string }): EndedTask => ({
  agentId: "dev",
  channelId: "c1",
  channelKind: "channel",
  channelName: "produto",
  threadId: null,
  status: "done",
  label: "Revisar o PR #231",
  background: false,
  routine: null,
  startedAt: "2026-11-02T13:00:00.000Z",
  finishedAt: "2026-11-02T13:20:00.000Z",
  stoppedBy: null,
  ...over,
});

const NONE: ReadonlySet<string> = new Set();

describe("a task's row (ADR 0125)", () => {
  test("its state: working, waiting on an ok or an answer, queued, and stopping once asked here", async () => {
    const t = await translator("pt-BR");
    const said = (over: Partial<ManagedTask>, stopping = NONE) =>
      stateText(t, rowState(task({ runId: "r1", ...over }), stopping));
    expect(said({ status: "running" })).toBe("Trabalhando");
    expect(said({ status: "waiting_approval" })).toBe("Espera seu ok");
    expect(said({ status: "waiting_input" })).toBe("Espera resposta");
    expect(said({ status: "queued" })).toBe("Na fila");
    expect(said({ status: "waiting_approval" }, new Set(["r1"]))).toBe("Parando…");
  });

  test("under the title: where, who asked and the plan; where is left out when it already is the title", async () => {
    const t = await translator("pt-BR");
    const asked = task({
      runId: "r1",
      channelKind: "channel",
      channelName: "produto",
      label: "Corrigir o link de cancelar",
      requester: { userId: "me", name: "Bia" },
      plan: { done: 9, total: 14 },
    });
    expect(taskSubline(t, asked, "me", taskTitle(t, asked))).toBe("#produto · Você pediu · 9 de 14 feitos");
    expect(taskSubline(t, { ...asked, plan: null }, "other", taskTitle(t, asked))).toBe("#produto · Bia pediu");
    // A DM's task with no label of its own is titled by where it is: said once.
    const dm = task({ runId: "r2", requester: { userId: "me", name: "Bia" } });
    expect(taskTitle(t, dm)).toBe("Conversa direta");
    expect(taskSubline(t, dm, "me", taskTitle(t, dm))).toBe("Você pediu");
  });

  test("an agent's row: how its tasks stand, or queued when they only wait their turn", async () => {
    const t = await translator("pt-BR");
    expect(groupLine(t, { working: 1, waiting: 1 })).toEqual({
      mark: "working",
      text: "1 trabalhando · 1 espera você",
    });
    expect(groupLine(t, { working: 0, waiting: 2 })).toEqual({ mark: "waiting", text: "2 esperam você" });
    expect(groupLine(t, { working: 0, waiting: 0 })).toEqual({ mark: "queued", text: "Na fila" });
  });
});

describe("what a task uses now", () => {
  test("a computer brain says what it called through us", async () => {
    const t = await translator("pt-BR");
    const browsing = {
      kind: "browser" as const,
      activity: { kind: "browsing" as const },
      detail: "página de cancelar",
    };
    expect(usingNow(t, { kind: "brain", brain: "claude_code", inner: browsing, detail: null })).toEqual({
      brain: "claude_code",
      activity: null,
      name: "Claude Code",
      detail: "Navegador · página de cancelar",
    });
    expect(usingNow(t, { kind: "brain", brain: "codex", inner: null, detail: null })?.detail).toBeNull();
  });

  test("the agent's own programs, an app by its name, and our own tools by what they do", async () => {
    const t = await translator("pt-BR");
    const terminal = usingNow(t, {
      kind: "terminal",
      activity: { kind: "runningCommand" },
      detail: "consultas lentas",
    });
    expect(terminal).toMatchObject({ brain: null, name: "Terminal", detail: "consultas lentas" });
    const github = usingNow(t, {
      kind: "app",
      activity: { kind: "consulting", app: "GitHub", service: "github" },
      detail: "PR #231",
    });
    expect(github).toMatchObject({ name: "GitHub", detail: "PR #231" });
    const writing = { kind: "agentes" as const, activity: { kind: "writingWiki" as const }, detail: "Roadmap" };
    const wiki = usingNow(t, writing, { locale: "pt-BR" });
    expect(wiki?.name).toBe("agentes");
    expect(wiki?.detail).toBe("Escrevendo na wiki · Roadmap");
  });

  test("nothing while it waits its turn", async () => {
    const t = await translator("pt-BR");
    expect(usingNow(t, taskProgram(task({ runId: "r1", status: "queued" })))).toBeNull();
  });
});

describe("what ended today", () => {
  test("how each ended, and who stopped it", async () => {
    const t = await translator("pt-BR");
    expect(endedText(t, ended({ runId: "a" }), "me")).toBe("Terminou");
    expect(endedText(t, ended({ runId: "b", status: "failed" }), "me")).toBe("Não conseguiu");
    const byMe = ended({ runId: "c", status: "canceled", stoppedBy: { userId: "me", name: "Bia" } });
    expect(endedText(t, byMe, "me")).toBe("Você parou");
    const byAna = ended({ runId: "d", status: "canceled", stoppedBy: { userId: "ana", name: "Ana" } });
    expect(endedText(t, byAna, "me")).toBe("Ana parou");
    expect(endedText(t, ended({ runId: "e", status: "canceled" }), "me")).toBe("Parada");
  });

  test("the latest first", () => {
    const list = [
      ended({ runId: "old", finishedAt: "2026-11-02T09:00:00.000Z" }),
      ended({ runId: "new", finishedAt: "2026-11-02T15:00:00.000Z" }),
    ];
    expect(endedLatestFirst(list).map((e) => e.runId)).toEqual(["new", "old"]);
  });
});

describe("an agent's tasks, from its DM's header", () => {
  const here = task({ runId: "here", createdAt: "2026-11-02T14:00:00.000Z" });
  const review = task({
    runId: "review",
    channelId: "c1",
    channelKind: "channel",
    channelName: "produto",
    status: "waiting_approval",
    createdAt: "2026-11-02T13:50:00.000Z",
  });
  const routine = task({
    runId: "routine",
    channelId: "room",
    background: true,
    routine: { id: "rt1", name: "Atualizar as dependências" },
    createdAt: "2026-11-02T13:00:00.000Z",
  });
  const other = task({ runId: "other", agentId: "infra", channelId: "c2" });
  const place = { channelId: "dm1", threadId: null };

  test("people's tasks first, then the routines', the ones asked here tagged; how many work, wait, can stop", () => {
    const view = agentTasksOf([here, review, routine, other], "dev", place, NONE);
    expect(view?.rows.map((r) => [r.task.runId, r.here])).toEqual([
      ["review", false],
      ["here", true],
      ["routine", false],
    ]);
    expect(view?.working).toBe(2);
    expect(view?.waiting).toBe(1);
    expect(view?.stoppable).toEqual(["review", "here", "routine"]);
  });

  test("one asked to stop, or one they may not stop, isn't stopped again by 'Parar todas'", () => {
    const view = agentTasksOf([here, { ...review, canStop: false }, routine], "dev", place, new Set(["here"]));
    expect(view?.stoppable).toEqual(["routine"]);
  });

  test("nothing while the agent has no tasks; nothing tagged when opened from nowhere", () => {
    expect(agentTasksOf([other], "dev", place, NONE)).toBeNull();
    expect(agentTasksOf([here], "dev", null, NONE)?.rows.map((r) => r.here)).toEqual([false]);
  });

  test("in a thread, here is that thread; the DM's main timeline is elsewhere", () => {
    const inThread = task({ runId: "thread", threadId: "t1" });
    expect(isHere(inThread, { channelId: "dm1", threadId: "t1" })).toBe(true);
    expect(isHere(here, { channelId: "dm1", threadId: "t1" })).toBe(false);
    const view = agentTasksOf([here, inThread], "dev", { channelId: "dm1", threadId: "t1" }, NONE);
    expect(view?.rows.filter((r) => r.here).map((r) => r.task.runId)).toEqual(["thread"]);
  });

  test("the header's count: the orbit while some work, the waiting mark otherwise, and who waits when both", () => {
    const both = agentTasksOf([here, review], "dev", place, NONE);
    expect(both && tasksBadge(both)).toEqual({ count: 2, mark: "working", waiting: 1, room: 1.9 });
    const waits = agentTasksOf([review], "dev", place, NONE);
    expect(waits && tasksBadge(waits)).toEqual({ count: 1, mark: "ok", waiting: null, room: 1.3 });
    const queued = agentTasksOf([{ ...here, status: "queued" }], "dev", place, NONE);
    expect(queued && tasksBadge(queued).mark).toBe("queued");
  });

  test("'Feitas hoje' counts what the agent finished, not what was stopped or failed", () => {
    const list = [
      ended({ runId: "a" }),
      ended({ runId: "b", status: "canceled" }),
      ended({ runId: "c", status: "failed" }),
      ended({ runId: "d", agentId: "infra" }),
    ];
    expect(doneTodayOf(list, "dev")).toBe(1);
  });

  test("its screen knows the conversation it came from", () => {
    expect(agentTasksHref("dev", { channelId: "dm1", threadId: null })).toBe("/agent-tasks/dev?channel=dm1");
    expect(agentTasksHref("dev", { channelId: "dm1", threadId: "t1" })).toBe("/agent-tasks/dev?channel=dm1&thread=t1");
    expect(agentTasksHref("dev", null)).toBe("/agent-tasks/dev");
  });
});

describe("navigation", () => {
  test("the task manager, a task and an agent's tasks are pushed screens, in the stack", () => {
    const layout = readFileSync(join(APP, "_layout.tsx"), "utf8");
    expect(layout).toContain(`name="task-manager/index" options={{ ...pushed, ...scrollUnder }}`);
    expect(layout).toContain(`name="task-manager/[runId]" options={{ ...pushed, ...scrollUnder }}`);
    expect(layout).toContain(`name="agent-tasks/[agentId]" options={{ ...pushed, ...scrollUnder }}`);
  });
});
