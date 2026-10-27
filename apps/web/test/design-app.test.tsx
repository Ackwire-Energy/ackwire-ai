import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Run, RunStep } from "@agenteschat/client";
import { agentStateIn, agentStateOfRun, type LiveRun } from "@agenteschat/client";
import { workFromSteps, workHeader } from "@agenteschat/client/lib/work";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) =>
  act(async () =>
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } }),
  );

const live = (over: Partial<LiveRun>): LiveRun => ({
  runId: "r",
  agentId: "a",
  channelId: "c",
  threadId: "t",
  status: "running",
  text: "",
  lastSeq: 0,
  ...over,
});

describe("the living avatar follows the run", () => {
  test("queued/thinking/running without words → thinking; words → writing; done/failed/approval → idle", () => {
    expect(agentStateOfRun(live({ status: "queued" }))).toBe("thinking");
    expect(agentStateOfRun(live({ status: "thinking" }))).toBe("thinking");
    expect(agentStateOfRun(live({ status: "running" }))).toBe("thinking");
    expect(agentStateOfRun(live({ status: "running", text: "Achei" }))).toBe("writing");
    expect(agentStateOfRun(live({ status: "done", text: "Achei" }))).toBe("idle");
    expect(agentStateOfRun(live({ status: "failed" }))).toBe("idle");
    expect(agentStateOfRun(live({ status: "waiting_approval" }))).toBe("idle");
    const state = {
      runs: {
        r1: live({ runId: "r1", status: "thinking" }),
        r2: live({ runId: "r2", status: "running", text: "x", channelId: "other" }),
      },
      finished: {},
    };
    expect(agentStateIn(state, "a")).toBe("writing");
    expect(agentStateIn(state, "a", "c")).toBe("thinking");
    expect(agentStateIn(state, "b")).toBe("idle");
  });
});

describe("work summary", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 22, 9, s)).toISOString();
  const steps: RunStep[] = [
    { seq: 1, kind: "context", data: {}, createdAt: at(0) },
    { seq: 2, kind: "tool_call", data: { toolUseId: "t1", name: "himetrica_get_summary" }, createdAt: at(1) },
    { seq: 3, kind: "tool_result", data: { toolUseId: "t1", isError: false }, createdAt: at(4) },
    { seq: 4, kind: "tool_call", data: { toolUseId: "t2", name: "create_artifact" }, createdAt: at(5) },
    { seq: 5, kind: "tool_result", data: { toolUseId: "t2", isError: true }, createdAt: at(8) },
    { seq: 6, kind: "message", data: {}, createdAt: at(12) },
  ];
  test("from the run's steps: tool calls, apps used, duration", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    const w = workFromSteps(steps, { createdAt: at(0), finishedAt: at(12) });
    expect(w.steps.map((s) => [s.kind, s.ms, s.failed])).toEqual([
      ["consulting", 3000, false],
      ["writingDrive", 3000, true],
    ]);
    expect(w.connectors).toEqual(["himetrica", "Drive"]);
    expect(workHeader(t, { steps: w.steps.length, connectors: w.connectors, durationMs: w.durationMs })).toEqual({
      steps: "2 passos",
      connectors: "himetrica, Drive",
      duration: "12 s",
    });
  });

  test("under an agent's message: opens on click and loads the steps", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const asked: string[] = [];
    api.agents.run = async (_orgId, runId) => {
      asked.push(runId);
      return {
        run: { id: runId, createdAt: at(0), finishedAt: at(12) } as Run,
        steps,
      };
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const head = screen().getAllByRole("button", { name: /Ver o que ela fez/ })[0] as HTMLElement;
    expect(asked).toEqual([]);
    await click(head);
    await settle(4);
    expect(asked).toEqual(["r-1"]);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    // Once loaded, the block's line says how many tools and how long.
    expect(head.textContent).toContain("Usou 2 ferramentas");
    expect(head.textContent).toContain("12 s");
    const work = head.closest(".ac-tools") as HTMLElement;
    expect(within(work).getByText("Consultou o Himetrica")).toBeTruthy();
    // The one that failed says so, and doesn't read as done.
    expect(within(work).getByText("Deu erro escrevendo no Drive")).toBeTruthy();
  });
});

describe("⌘K palette", () => {
  const press = () =>
    act(async () => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });

  test("opens with ⌘K; filters settings sections; Enter goes there", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(seedState()) });
    await settle(6);
    await press();
    const input = screen().getByRole("combobox", { name: "Ir para, ou pedir a um agente" });
    await type(input, "conectores");
    const list = screen().getByRole("listbox", { name: "Resultados" });
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("Conectores");
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/connectors`);
  });

  test("ask an agent: opens its DM with the text in the composer", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(seedState()) });
    await settle(6);
    await press();
    const input = screen().getByRole("combobox", { name: "Ir para, ou pedir a um agente" });
    await type(input, "Ada, resume a semana");
    const ask = within(screen().getByRole("listbox", { name: "Resultados" })).getByRole("option", {
      name: /Ada, resume a semana/,
    });
    await click(ask);
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    const composer = screen().getByRole("combobox", { name: "Mensagem para Ada" }) as HTMLTextAreaElement;
    expect(composer.value).toBe("resume a semana");
  });
});

describe("composer in a DM", () => {
  test("the target agent pill; '/' commands insert a ready request", async () => {
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const composer = screen().getByRole("combobox", { name: "Mensagem para Ada" }) as HTMLTextAreaElement;
    const card = composer.closest(".ac-composer") as HTMLElement;
    expect(card.querySelector(".ac-composer__agent")?.textContent).toContain("Ada");
    await type(composer, "/");
    const menu = screen().getByRole("listbox", { name: "Comandos" });
    expect(
      within(menu)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining("/relatório"),
      expect.stringContaining("/rotina"),
      expect.stringContaining("/pc"),
      expect.stringContaining("/mission"),
    ]);
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    expect(composer.value).toBe("monte um relatório sobre ");
  });
});
