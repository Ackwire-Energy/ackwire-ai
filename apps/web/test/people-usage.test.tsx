import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message, PeopleUsage, PersonUsage } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const NOW = new Date().toISOString();
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
/** Text with Intl's no-break spaces as plain ones ("US$ 30,00"). */
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s/g, " ");
const tab = async (name: string) => {
  await act(async () => fireEvent.mouseDown(screen().getByRole("tab", { name }), { button: 0 }));
  await settle(6);
};

const people: PeopleUsage = {
  month: NOW.slice(0, 7),
  since: NOW,
  until: NOW,
  totalUsd: 36.3,
  plansOnly: false,
  limitsOn: true,
  live: [
    {
      personId: "u-joao",
      agentId: ATLAS_ID,
      routine: false,
      place: { kind: "private" },
      title: null,
      startedAt: NOW,
    },
  ],
  people: [
    {
      userId: "u-joao",
      name: "João",
      image: null,
      owner: false,
      roleIds: [],
      runs: 64,
      costUsd: 30,
      estimated: false,
      agents: [{ agentId: ATLAS_ID, share: 100 }],
      monthUsd: 30,
      limitUsd: 30,
      limitFrom: "default",
      limitRoleId: null,
      raiseToUsd: 45,
      percent: 100,
      state: "at",
      requested: true,
      reachedAt: NOW,
      caresFor: [],
      created: 1,
      lastActiveAt: NOW,
      now: { agentId: ATLAS_ID, place: { kind: "private" }, title: null, startedAt: NOW },
    },
    {
      userId: "u-walter",
      name: "Walter",
      image: null,
      owner: true,
      roleIds: [],
      runs: 0,
      costUsd: 0,
      estimated: false,
      agents: [],
      monthUsd: 0,
      limitUsd: null,
      limitFrom: "owner",
      limitRoleId: null,
      raiseToUsd: null,
      percent: null,
      state: "none",
      requested: false,
      reachedAt: null,
      caresFor: [ATLAS_ID],
      created: 0,
      lastActiveAt: null,
      now: null,
    },
  ],
};

const joaoMonth = (money: boolean): PersonUsage => ({
  userId: "u-joao",
  name: "João",
  image: null,
  roleIds: [],
  owner: false,
  money,
  renewsAt: NOW,
  since: NOW,
  until: NOW,
  limit: money
    ? {
        percent: 100,
        state: "at",
        requested: true,
        reachedAt: NOW,
        monthUsd: 30,
        limitUsd: 30,
        limitFrom: "default",
        limitRoleId: null,
        raiseToUsd: 45,
      }
    : { percent: 92, state: "near", requested: false, reachedAt: null },
  total: money ? 30 : 92,
  days: [{ date: NOW.slice(0, 10), agents: { [ATLAS_ID]: money ? 30 : 92 } }],
  agents: [{ agentId: ATLAS_ID, runs: 64, amount: money ? 30 : 92 }],
  recent: [
    {
      kind: "work",
      agentId: ATLAS_ID,
      place: { kind: "channel", channelId: ENG_ID, channelName: "eng" },
      title: "Proposta para a Lumen Tiles",
      startedAt: NOW,
      minutes: 14,
      amount: money ? 0.82 : 3,
    },
    { kind: "private", agentId: ATLAS_ID, runs: 6, amount: money ? 1.1 : 4, lastAt: NOW },
  ],
  created: [],
});

describe("Orçamento e uso › Pessoas", () => {
  test("admins: each person's month with the limit, who uses agents now, the drawer with a DM as a count only", async () => {
    const state = seedState();
    state.peopleUsage = people;
    state.personUsage = { "u-joao": joaoMonth(true) };
    await renderApp(`/org/${ORG_ID}/settings/usage`, { api: createFakeApi(state) });
    await settle(5);
    await tab("Pessoas");
    const table = screen().getByRole("table");
    const joao = within(table).getByText("João").closest("tr") as HTMLElement;
    expect(text(joao)).toContain("US$ 30,00");
    expect(text(joao)).toContain("No limite");
    expect(text(joao)).toContain("Em conversa privada com Atlas");
    expect(text(document.body)).toContain("0 perto do limite · 1 no limite · 1 sem uso no período");
    expect(text(document.body)).toContain("Agora");

    await click(joao);
    const drawer = screen().getByRole("dialog", { name: "João" });
    expect(text(drawer)).toContain("Limite deste mês: US$ 30,00");
    expect(text(drawer)).toContain("Proposta para a Lumen Tiles");
    expect(text(drawer)).toContain("Conversa privada com Atlas");
    expect(text(drawer)).toContain("6 pedidos");
    expect(within(drawer).getByRole("button", { name: /^Aumentar para US\$\s45,00 este mês$/ })).toBeTruthy();
  });

  test("Limites: off by default; a default and an exception are saved", async () => {
    const state = seedState();
    state.peopleUsage = { ...people, limitsOn: false };
    await renderApp(`/org/${ORG_ID}/settings/usage`, { api: createFakeApi(state) });
    await settle(5);
    await tab("Pessoas");
    await click(screen().getByRole("button", { name: "Defina um limite por pessoa em Limites" }));
    expect(screen().getByRole("heading", { name: "Limite de uso por pessoa" })).toBeTruthy();
    expect(text(document.body)).toContain(
      "Vale o limite da pessoa. Sem ele, o maior entre os papéis dela. Sem nenhum, o padrão. Donos não têm limite.",
    );
    await click(screen().getByRole("button", { name: "Salvar" }));
    expect(state.calls.find((c) => c.method === "orgs.setPersonLimits")?.args[1]).toEqual({
      defaultUsd: null,
      roles: {},
      people: {},
      onLimit: "block",
      warn: true,
    });
  });

  test("members: only Seu uso, in percentages, never money", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    state.personUsage = { "u-walter": { ...joaoMonth(false), userId: "u-walter", name: "Walter" } };
    await renderApp(`/org/${ORG_ID}/settings/usage`, { api: createFakeApi(state) });
    await settle(5);
    expect(screen().queryByRole("tab", { name: "Pessoas" })).toBeNull();
    await tab("Seu uso");
    expect(text(document.body)).toContain("Você usou 92% do seu limite deste mês");
    expect(text(document.body)).toContain("4% do limite");
    expect(text(document.body)).not.toContain("US$");
  });
});

describe("the agent's card at the person's limit", () => {
  const card = (state: "limited" | "raised", userId = "u-walter"): Message => ({
    id: "m-limit",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ATLAS_ID },
    body: "server text",
    mentionedAgentIds: [],
    agentRunId: "r-limit",
    meta: {
      bodyCode: "person_limit",
      actionCard: {
        kind: "person_limit",
        state,
        userId,
        agentId: ATLAS_ID,
        runId: "r-limit",
        renewsAt: "2026-12-01T00:00:00.000Z",
        ...(state === "raised" ? { byUserId: "u-joao" } : {}),
      },
    },
    createdAt: NOW,
  });

  test("its person asks for more; anyone else reads who reached it; a raise says go on", async () => {
    const state = seedState();
    state.messages = [card("limited")];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    expect(text(document.body)).toContain("Você chegou ao seu limite de uso deste mês");
    await click(screen().getByRole("button", { name: "Pedir mais" }));
    expect(state.calls.some((c) => c.method === "orgs.requestMoreUsage")).toBe(true);
    expect(screen().getByRole("button", { name: "Pedido enviado" })).toBeTruthy();
    cleanup();

    const other = seedState();
    other.messages = [card("limited", "u-joao")];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(other) });
    await settle(5);
    expect(text(document.body)).toContain("João chegou ao limite de uso deste mês");
    expect(screen().queryByRole("button", { name: "Pedir mais" })).toBeNull();
    cleanup();

    const raised = seedState();
    raised.messages = [card("raised")];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(raised) });
    await settle(5);
    expect(text(document.body)).toContain("João aumentou seu limite deste mês. Pode continuar.");
  });
});

describe("a request for more, in the inbox of who decides", () => {
  test("Aumentar para US$ 45 este mês and Recusar answer it from the row", async () => {
    const state = seedState({
      notifications: [
        notification({
          id: "n-limit",
          kind: "usage_limit",
          waiting: true,
          actors: [{ type: "user", id: "u-joao" }],
          source: { userId: "u-joao" },
          latest: {
            statusTo: "request",
            percent: 100,
            limitUsd: 30,
            raiseToUsd: 45,
            limitFrom: "default",
            runs: 64,
            title: "Atlas",
            share: 80,
          },
        }),
      ],
    });
    await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
    await settle(6);
    expect(text(document.body)).toContain("João chegou ao limite de US$ 30,00 e pediu mais");
    expect(text(document.body)).toContain("64 pedidos este mês, 80% com Atlas. Limite padrão do workspace.");
    await click(screen().getAllByRole("button", { name: /^Aumentar para US\$\s45,00 este mês$/ })[0] as HTMLElement);
    expect(state.calls.find((c) => c.method === "orgs.raisePersonLimit")?.args).toEqual([ORG_ID, "u-joao", 45]);
    await click(screen().getAllByRole("button", { name: "Recusar" })[0] as HTMLElement);
    expect(state.calls.some((c) => c.method === "orgs.refuseMoreUsage")).toBe(true);
  });
});
