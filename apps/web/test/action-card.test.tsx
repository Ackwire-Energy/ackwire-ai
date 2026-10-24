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
    state.messages.push(
      card("c-ada", { what: "claude", agentIds: [ADA_ID], why: "Você pediu para a Ada usar o seu plano." }),
      card("c-both", { what: "claude", agentIds: [ATLAS_ID, ADA_ID], why: "Os dois com o seu plano." }, 1),
    );
    await open(state);
    const ada = cardRow("Conectar o plano do Claude para Ada");
    expect(ada.textContent).toContain("Você pediu para a Ada usar o seu plano.");
    expect(ada.textContent).not.toContain("server text");
    // One agent named: the dialog is for her alone, with no choice of agent.
    await click(within(ada).getByRole("button", { name: "Conectar" }));
    const plan = dialog("Conectar o seu plano do Claude") as HTMLElement;
    expect(plan).not.toBeNull();
    expect(within(plan).queryByRole("combobox", { name: "Para qual agente" })).toBeNull();
    await click(within(plan).getByRole("button", { name: "Fechar" }));
    // Two: a choice between them, the first one named chosen.
    await click(
      within(cardRow("Conectar o plano do Claude para Atlas e Ada")).getByRole("button", { name: "Conectar" }),
    );
    const both = dialog("Conectar o seu plano do Claude") as HTMLElement;
    expect(within(both).getByRole("combobox", { name: "Para qual agente" }).textContent).toContain("Atlas");
  });

  test("an organization's key: no agent named, the key dialog with its provider picked; it stays a button", async () => {
    const state = seedState();
    state.messages.push(
      card("c-key", { what: "api_key", provider: "openai", agentIds: [], why: "Sua chave da OpenAI." }),
    );
    await open(state);
    const row = cardRow("Adicionar uma chave de API");
    expect(row.textContent).not.toContain("Conectado");
    await click(within(row).getByRole("button", { name: "Conectar" }));
    const add = dialog("Adicionar uma chave de API") as HTMLElement;
    expect(within(add).getByRole("combobox", { name: "Provedor" }).textContent).toContain("OpenAI");
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
