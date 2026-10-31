import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

type State = ReturnType<typeof seedState>;

/** An agent's "Conectar uma IA" card in #eng (`meta.actionCard`), as `offer_connect_ai` posts it. */
const card = (id: string, params: Record<string, unknown>, minute = 0): Message => ({
  id,
  channelId: ENG_ID,
  threadId: null,
  author: { type: "agent", id: ATLAS_ID },
  body: "Connect an AI: server text",
  mentionedAgentIds: [],
  agentRunId: `r-${id}`,
  meta: { bodyCode: "action_connect_ai", actionCard: { kind: "connect_ai", forUserId: "u-walter", params } },
  createdAt: new Date(NOW.getTime() + minute * 60_000).toISOString(),
});

const open = async (state: State) => {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
};
const click = async (el: HTMLElement, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const cardRow = (title: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.querySelector(".waitcard")?.textContent?.includes(title)) as HTMLElement;
const dialog = (name: string) => screen().queryByRole("dialog", { name });
const withBrain = (state: State, agentId: string, kind: NonNullable<Agent["brain"]>["kind"]) => {
  const agent = state.agents.find((a) => a.id === agentId);
  if (agent) agent.brain = { kind, model: null };
};

describe("an agent's Connect card", () => {
  test("in place of its text: the step for the agents it names, the agent's line, and Connect opens that step for them", async () => {
    const state = seedState();
    // A plan thinks only for its owner's agents (ADR 0059 §3): Walter connects his for his own.
    for (const a of state.agents) a.ownerUserId = "u-walter";
    state.messages.push(
      card("c-ada", { what: "claude", agentIds: [ADA_ID], why: "Você pediu para a Ada usar o seu plano." }),
      card("c-both", { what: "claude", agentIds: [ATLAS_ID, ADA_ID], why: "Os dois com o seu plano." }, 1),
    );
    await open(state);
    const ada = cardRow("Conectar o plano do Claude para Ada");
    expect(ada.textContent).toContain("Você pediu para a Ada usar o seu plano.");
    expect(ada.textContent).not.toContain("server text");
    // One agent named: the dialog is for her alone, on Claude's plan, with no choice of agent.
    await click(within(ada).getByRole("button", { name: "Conectar" }));
    const plan = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(within(plan).getByRole("region", { name: "Seu plano do Claude" })).toBeTruthy();
    expect(within(plan).queryByRole("combobox", { name: "Agentes que usam este plano" })).toBeNull();
    await click(within(plan).getByRole("button", { name: "Fechar" }));
    // Two: a choice between them, the first one named chosen.
    await click(
      within(cardRow("Conectar o plano do Claude para Atlas e Ada")).getByRole("button", { name: "Conectar" }),
    );
    const both = dialog("Conectar uma IA") as HTMLElement;
    expect(within(both).getByRole("region", { name: "Seu plano do Claude" })).toBeTruthy();
    expect(within(both).getByRole("combobox", { name: "Agentes que usam este plano" }).textContent).toContain("Atlas");
  });

  test("an organization's key: no agent named, the key panel with its maker picked; it stays a button", async () => {
    const state = seedState();
    state.messages.push(
      card("c-key", { what: "api_key", provider: "openai", agentIds: [], why: "Sua chave da OpenAI." }),
    );
    await open(state);
    const row = cardRow("Adicionar uma chave de API");
    expect(row.textContent).not.toContain("Conectado");
    await click(within(row).getByRole("button", { name: "Conectar" }));
    const add = dialog("Conectar uma IA") as HTMLElement;
    const makers = within(add).getByRole("group", { name: "Provedor" });
    expect(within(makers).getByRole("button", { name: "OpenAI" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("done from live data: 'Conectado' once its agents think (with that plan, for a plan's card)", async () => {
    const state = seedState({
      aiStatus: {
        any: true,
        agents: [
          { agentId: ADA_ID, state: "ready" },
          { agentId: ATLAS_ID, state: "no_ai", reason: "no_key" },
        ],
      },
    });
    withBrain(state, ADA_ID, "claude_code");
    state.messages.push(
      card("c-claude", { what: "claude", agentIds: [ADA_ID], why: "Plano do Claude." }),
      card("c-chatgpt", { what: "chatgpt", agentIds: [ADA_ID], why: "Plano do ChatGPT." }, 1),
      card("c-atlas", { agentIds: [ATLAS_ID], why: "O Atlas ainda não tem IA." }, 2),
    );
    await open(state);
    const claude = cardRow("Conectar o plano do Claude para Ada");
    expect(within(claude).queryByRole("button", { name: "Conectar" })).toBeNull();
    expect(claude.textContent).toContain("Conectado");
    // Ada thinks, but not with a ChatGPT plan; Atlas has no AI yet.
    for (const title of ["Conectar o plano do ChatGPT para Ada", "Conectar uma IA para Atlas"]) {
      const row = cardRow(title);
      expect(row.textContent).not.toContain("Conectado");
      expect(within(row).getByRole("button", { name: "Conectar" })).toBeTruthy();
    }
  });
});

describe("a stretch's pause card (ADR 0089)", () => {
  /** The card a stretch's limit posts as Atlas in #eng, for the agents it holds. */
  const pause = (id: string, actionCard: Record<string, unknown>, minute = 0): Message => ({
    ...card(id, {}, minute),
    body: "Ada and Atlas stopped to check with you: server text",
    meta: {
      bodyCode: `stretch_paused_${actionCard.reason}`,
      actionCard: {
        kind: "stretch_paused",
        stretchId: "s-1",
        state: "paused",
        forUserId: "u-joao",
        held: [],
        continuedByUserId: null,
        continuedAt: null,
        ...actionCard,
      },
    },
  });

  test("who stopped and why, in place of its text; Continuar lets them go on", async () => {
    const state = seedState();
    state.messages.push(pause("p-runs", { reason: "runs", limit: 50, agentIds: [ADA_ID, ATLAS_ID] }));
    await open(state);
    const row = cardRow("Ada e Atlas pararam para te consultar · 50 passos sozinhos desde o seu pedido");
    expect(row.textContent).not.toContain("server text");
    await click(within(row).getByRole("button", { name: "Continuar" }));
    expect(state.calls.some((c) => c.method === "chat.answerNow" && c.args[1] === "p-runs")).toBe(true);
  });

  test("an agent's budget share in money for who can see costs; once continued, who let them and no button", async () => {
    const state = seedState();
    state.messages.push(
      pause("p-spend", { reason: "spend", limit: 20, agentIds: [ADA_ID] }),
      pause(
        "p-done",
        {
          reason: "runs",
          limit: 10,
          agentIds: [ATLAS_ID],
          state: "continued",
          continuedByUserId: "u-walter",
          continuedAt: NOW.toISOString(),
        },
        1,
      ),
    );
    await open(state);
    // Ada's own budget is US$ 40: 20% of it.
    const spend = cardRow("Ada parou para te consultar · usou US$ 8 (20% do orçamento do mês) nisso sem você");
    expect(within(spend).getByRole("button", { name: "Continuar" })).toBeTruthy();
    const done = cardRow("Atlas parou para te consultar · 10 passos sem você desde o seu pedido");
    expect(done.textContent).toContain("Você deixou continuar");
    expect(within(done).queryByRole("button", { name: "Continuar" })).toBeNull();
  });
});
