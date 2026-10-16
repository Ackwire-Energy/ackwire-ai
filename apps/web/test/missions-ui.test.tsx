import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { MissionEligibleAgent } from "@/api/types";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Missões (Threads.html)", () => {
  test("the sidebar item opens the Threads page on the Missões tab; empty: a designed state", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/threads?tab=missions`, { api: createFakeApi() });
    await settle();
    expect(router.state.location.search).toEqual({ tab: "missions" });
    expect(screen().getByRole("heading", { level: 1, name: "Missões" })).toBeTruthy();
    expect(screen().getByText("Nenhuma missão ainda")).toBeTruthy();
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    // Missões is a tab of Threads: one sidebar item.
    expect(within(nav).getByRole("link", { name: /Threads/ })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: /^Missões/ })).toBeNull();
  });

  test("a mission's card: title, agent, state, the plan as items, the computer, Abrir thread", async () => {
    const api = createFakeApi(seedState());
    await api.missions.create(ORG_ID, { agentId: ADA_ID, goal: "Construir o app mobile", channelId: ENG_ID });
    await renderApp(`/org/${ORG_ID}/threads?tab=missions`, { api });
    await settle(6);
    const card = screen().getByRole("article", { name: /Missão Construir o app mobile/ });
    expect(within(card).getByText("Plano proposto")).toBeTruthy();
    // No plan yet (the executor is still exploring): no "0 de 0" count.
    expect(within(card).getByText("Sem itens ainda")).toBeTruthy();
    expect(within(card).getAllByText(/MacBook/).length).toBeGreaterThan(0);
    expect(within(card).getAllByRole("button", { name: /Abrir thread/ }).length).toBeGreaterThan(0);
  });

  test("a thread with a mission (Todas): the mission header's look in the row — agent, Missão · N de M itens, its state", async () => {
    const api = createFakeApi(seedState());
    const base = { channelId: ENG_ID, firstMessageId: "m1", lastMessageId: "m1" };
    await api.threads.create(ORG_ID, {
      ...base,
      title: "App mobile",
      mission: { id: "mission_1", agentId: ADA_ID, status: "active", planDone: 4, planTotal: 12, waitingYou: 2 },
    } as Parameters<typeof api.threads.create>[1]);
    await api.threads.create(ORG_ID, { ...base, title: "Só conversa" });
    await renderApp(`/org/${ORG_ID}/threads`, { api });
    await settle(6);
    const row = screen().getByRole("article", { name: "App mobile" });
    const line = row.querySelector(".thread-row__mission") as HTMLElement;
    expect(line.textContent).toContain("Missão");
    expect(line.textContent).toContain("4 de 12 itens");
    // The agent's avatar in the kind column (and a small one in the line for phones), no flag icon.
    expect(row.querySelector(".thread-kind--agent .ac-avatar")).toBeTruthy();
    expect(line.querySelector(".ac-avatar")).toBeTruthy();
    expect(within(row).getByText("Esperando você")).toBeTruthy();
    const plain = screen().getByRole("article", { name: "Só conversa" });
    expect(plain.querySelector(".thread-row__mission")).toBeNull();
    expect(plain.querySelector(".thread-kind--agent")).toBeNull();
  });

  test("an old proposal's thread-start marker (no link card in the reply) shows the mission card instead", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const mission = await api.missions.create(ORG_ID, {
      agentId: ADA_ID,
      goal: "Fotos",
      title: "Fotos",
      channelId: ENG_ID,
    });
    const start = {
      title: "Fotos",
      contextChannelId: ENG_ID,
      firstMessageId: "m-old",
      lastMessageId: "m-old",
      count: 1,
    };
    state.messages.push({
      id: "root-old",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-walter" },
      body: "Fotos",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: { threadStart: { ...start, moved: false, movedCount: 0 } },
      createdAt: new Date().toISOString(),
    });
    await api.threads.create(ORG_ID, {
      id: "root-old",
      channelId: ENG_ID,
      firstMessageId: "m-old",
      lastMessageId: "m-old",
      title: "Fotos",
      mission: { id: mission.id, agentId: ADA_ID, status: "proposed", planDone: 0, planTotal: 0, waitingYou: 0 },
    } as Parameters<typeof api.threads.create>[1]);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    expect(screen().getByRole("region", { name: "Missão Fotos" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("Este trecho virou contexto da thread");
  });

  const pick = (agentId: string, name: string, extra: Partial<MissionEligibleAgent> = {}): MissionEligibleAgent => ({
    agentId,
    handle: name.toLowerCase(),
    name,
    eligible: true,
    reason: null,
    canManage: true,
    machine: { id: "machine_1", name: "mac", online: true },
    ready: true,
    executors: ["claude", "agent"],
    defaultExecutor: "claude",
    codexTooOld: false,
    ...extra,
  });
  const openAgents = async () => {
    await act(async () => fireEvent.click(screen().getAllByRole("button", { name: /Nova missão/ })[0] as HTMLElement));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Nova missão" });
    const trigger = within(dialog).getByRole("combobox", { name: "Agente" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    return { dialog, trigger };
  };

  test("Nova missão: two agents on one computer are both selectable; the first eligible is chosen", async () => {
    const api = createFakeApi(seedState());
    api.missions.eligibleAgents = async () => [pick(ADA_ID, "Ada"), pick(ATLAS_ID, "Atlas")];
    await renderApp(`/org/${ORG_ID}/threads?tab=missions`, { api });
    await settle(6);
    const { trigger } = await openAgents();
    expect(trigger.textContent).toContain("Ada");
    const ada = screen().getByRole("option", { name: /^Ada/ });
    const atlas = screen().getByRole("option", { name: /^Atlas/ });
    expect(ada.getAttribute("aria-disabled")).not.toBe("true");
    expect(atlas.getAttribute("aria-disabled")).not.toBe("true");
    expect(atlas.textContent).toContain("No mac");
  });

  test("Nova missão: Pedir aprovação de comandos starts at 'Só os arriscados' (Jev approves the low-risk ones)", async () => {
    const api = createFakeApi(seedState());
    api.missions.eligibleAgents = async () => [pick(ADA_ID, "Ada")];
    await renderApp(`/org/${ORG_ID}/threads?tab=missions`, { api });
    await settle(6);
    await act(async () => fireEvent.click(screen().getAllByRole("button", { name: /Nova missão/ })[0] as HTMLElement));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Nova missão" });
    const select = within(dialog).getByRole("combobox", { name: "Pedir aprovação de comandos" });
    expect(select.textContent).toContain("Só os arriscados (Jev aprova os de baixo risco)");
  });

  test("Nova missão: an agent that can't run one is listed disabled with the reason, and a link for its owner", async () => {
    const api = createFakeApi(seedState());
    api.missions.eligibleAgents = async () => [
      pick(ADA_ID, "Ada"),
      pick(ATLAS_ID, "Atlas", {
        eligible: false,
        reason: "cloud_computer",
        machine: null,
        ready: false,
        executors: [],
        defaultExecutor: null,
      }),
    ];
    await renderApp(`/org/${ORG_ID}/threads?tab=missions`, { api });
    await settle(6);
    const { dialog } = await openAgents();
    const atlas = screen().getByRole("option", { name: /^Atlas/ });
    expect(atlas.getAttribute("aria-disabled")).toBe("true");
    expect(atlas.textContent).toContain("missões lá chegam depois");
    // The open agent list hides the rest of the dialog from the accessibility tree (a modal popover).
    const blocked = within(dialog).getByRole("list", {
      name: "Agentes que ainda não podem rodar uma missão",
      hidden: true,
    });
    expect(
      within(blocked).getByRole("link", { name: "Conectar computador", hidden: true }).getAttribute("href"),
    ).toContain(`/agents/${ATLAS_ID}`);
    // Somebody can: no empty state.
    expect(within(dialog).queryByText("Nenhum agente pode rodar uma missão para você ainda")).toBeNull();
  });
});
