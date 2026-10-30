import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentDraft, AgentInput, AgentProposalCard, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { railStep, title, typeIn } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

type State = ReturnType<typeof seedState>;
const HOUR = 3_600_000;

/** Atlas's proposal of Nina in #eng (`meta.actionCard`), as `propose_agent` posts it. */
const proposal = (
  id: string,
  card: Partial<AgentProposalCard> = {},
  draft: Partial<AgentDraft> = {},
  minute = 0,
): Message => ({
  id,
  channelId: ENG_ID,
  threadId: null,
  author: { type: "agent", id: ATLAS_ID },
  body: "Proposed a new agent, Nina: server text",
  mentionedAgentIds: [],
  agentRunId: `r-${id}`,
  meta: {
    bodyCode: "agent_proposal",
    bodyParams: { name: "Nina" },
    actionCard: {
      kind: "agent_proposal",
      forUserId: "u-walter",
      params: {
        draft: {
          name: "Nina",
          handle: "nina",
          role: "Designer",
          instructions: "Desenha as telas.",
          appearance: { color: "rose", eyes: "happy", accessory: "bow" },
          channelIds: [ENG_ID],
          access: [],
          ai: { kind: "model" },
          ...draft,
        },
        why: "Você pediu alguém para o design.",
      },
      state: "pending",
      agentId: null,
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: new Date(Date.now() + 20 * HOUR).toISOString(),
      ...card,
    } satisfies AgentProposalCard,
  },
  createdAt: new Date(NOW.getTime() + minute * 60_000).toISOString(),
});

const click = async (el: HTMLElement, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const cardOf = (name: string) =>
  screen()
    .getAllByRole("article")
    .filter((a) => a.querySelector(".waitcard")?.textContent?.includes(name))
    .map((a) => a.querySelector(".waitcard") as HTMLElement);
const asMember = (state: State) => {
  const org = state.me?.organizations[0];
  if (org) org.role = "member";
};

describe("an agent's proposal of a new agent, in the chat", () => {
  test("the draft at a glance; Revisar opens Criar agente on it and Recusar says no", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1"));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const [card] = cardOf("Atlas propõe um novo agente");
    if (!card) throw new Error("no card");
    for (const shown of [
      "Nina",
      "@nina · Designer",
      "Pensa com o modelo do workspace",
      "Você pediu alguém para o design.",
    ])
      expect(card.textContent).toContain(shown);
    expect(card.textContent).not.toContain("server text");
    expect(within(card).getByRole("link", { name: "Revisar" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/new?proposal=p-1`,
    );
    await click(within(card).getByRole("button", { name: "Recusar" }));
    expect(state.calls.some((c) => c.method === "agents.denyProposal" && c.args[1] === "p-1")).toBe(true);
    const [after] = cardOf("Atlas propõe um novo agente");
    expect(after?.textContent).toContain("Recusada");
    expect(within(after as HTMLElement).queryByRole("button", { name: "Recusar" })).toBeNull();
  });

  test("read-only for who can't create agents; created links to the agent; expired after a day", async () => {
    const state = seedState();
    asMember(state);
    state.messages.push(
      proposal(
        "p-open",
        {},
        { ai: { kind: "account", brain: "claude_code", machineId: "m-1", accountId: "a-1", label: "Claude Max" } },
      ),
      proposal(
        "p-made",
        { state: "created", agentId: ATLAS_ID },
        { name: "Otto", handle: "otto", ai: { kind: "none" } },
        1,
      ),
      proposal("p-old", { expiresAt: new Date(Date.now() - HOUR).toISOString() }, { name: "Vera", handle: "vera" }, 2),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const [open] = cardOf("@nina");
    expect(open?.textContent).toContain("Pensa com Claude Max");
    expect(open?.textContent).toContain("Aguardando um admin");
    expect(within(open as HTMLElement).queryByRole("link", { name: "Revisar" })).toBeNull();
    expect(within(open as HTMLElement).queryByRole("button", { name: "Recusar" })).toBeNull();
    const [made] = cardOf("@otto");
    expect(made?.textContent).toContain("Criado");
    expect(made?.textContent).toContain("Sem IA ainda. Conecte uma depois de criar");
    expect(
      within(made as HTMLElement)
        .getByRole("link", { name: "Abrir perfil" })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
    const [old] = cardOf("@vera");
    expect(old?.textContent).toContain("Expirou");
  });
});

describe("Revisar: Criar agente filled in with the draft", () => {
  test("on its last step with the draft; creating sends the edits with the card, and no AI opens Connect for it", async () => {
    // No key and no plan: nothing to think with yet, so it is created and connected after.
    const state = seedState({ credentials: [], platformKey: false });
    state.messages.push(proposal("p-1", {}, { ai: { kind: "none" } }));
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    expect(title()).toBe("Tudo certo com a Nina?");
    const review = document.querySelector(".newag__review")?.textContent ?? "";
    for (const shown of ["Designer", "@nina", "Desenha as telas.", "eng", "Sem IA ainda"])
      expect(review).toContain(shown);
    // An edit on the way: the name.
    await click(railStep("Identidade"));
    await typeIn(screen().getByLabelText("Nome"), "Nina Simone");
    await settle(2);
    await click(railStep("Revisar e criar"));
    await click(screen().getByRole("button", { name: "Criar Nina Simone" }), 10);
    const created = state.calls.find((c) => c.method === "agents.create")?.args[1] as AgentInput | undefined;
    expect(created).toMatchObject({
      name: "Nina Simone",
      handle: "nina",
      role: "Designer",
      instructions: "Desenha as telas.",
      appearance: { color: "rose", eyes: "happy", accessory: "bow" },
      proposal: "p-1",
    });
    const connect = screen().getByRole("dialog", { name: /Conectar uma IA/ });
    // Another one starts empty, without the proposal.
    await click(within(connect).getByRole("button", { name: "Fechar" }));
    await click(screen().getByRole("button", { name: "Criar outro agente" }), 8);
    expect(title()).toBe("Qual vai ser o papel?");
  });

  test("a proposal already decided: no flow, a way back to the conversation", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1", { state: "denied" }));
    await renderApp(`/org/${ORG_ID}/agents/new?proposal=p-1`, { api: createFakeApi(state) });
    await settle(8);
    expect(screen().getByText("Esta proposta já foi decidida ou expirou.")).toBeTruthy();
    expect(screen().getByRole("link", { name: "Voltar para a conversa" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/c/${ENG_ID}`,
    );
  });
});
