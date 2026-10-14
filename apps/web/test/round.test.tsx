import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { channelNameError, toChannelName } from "@/components/NewChannelDialog";
import { modelChoices, suggestModel } from "@/lib/providers";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const pick = async (combobox: HTMLElement, option: RegExp | string) => {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await act(async () => fireEvent.click(screen().getByRole("option", { name: option })));
  await settle();
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });

describe("receipt on the right of the header line", () => {
  test("a person's message carries the check in the header aside", async () => {
    await go(`c/${ENG_ID}`);
    const ask = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("o login está devolvendo 401")) as HTMLElement;
    expect(ask.querySelector(".ac-msg__head .ac-msg__aside .ac-receipt__check")).not.toBeNull();
  });
});

describe("sidebar: no agent twice", () => {
  test("agents open their DM (with unread); 'Mensagens diretas' lists only people", async () => {
    const state = seedState();
    state.dms.push({ channelId: "dm-ada", with: { type: "agent", id: ADA_ID, name: "Ada", handle: "ada" } });
    state.dms.push({ channelId: "dm-joao", with: { type: "person", id: "u-joao", name: "João", handle: null } });
    const api = createFakeApi(state);
    const list = api.dms.list;
    api.dms.list = async (o) => (await list(o)).map((d) => ({ ...d, unread: d.with.id === ADA_ID ? 3 : 1 }));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const adaLinks = within(nav())
      .getAllByRole("link")
      .filter((l) => l.textContent?.includes("Ada"));
    expect(adaLinks).toHaveLength(1);
    expect(adaLinks[0]?.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    expect(within(adaLinks[0] as HTMLElement).getByLabelText("3 mensagens não lidas").textContent).toBe("3");
    const dmsGroup = within(nav()).getByText("Mensagens diretas").closest(".sidebar__group") as HTMLElement;
    expect(
      within(dmsGroup)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["JJoão1"]);
  });
});

describe("Criar canal", () => {
  test("name rules", () => {
    expect(toChannelName("Marketing Brasil")).toBe("marketing-brasil");
    expect(toChannelName("Ação!")).toBe("acao");
    expect(channelNameError("eng", new Set(["eng"]))).toBe("taken");
    expect(channelNameError("-x", new Set())).toBe("invalid");
    expect(channelNameError("vendas", new Set(["eng"]))).toBeNull();
  });

  test("dialog from the '+': validates, picks initial members, creates and opens the channel", async () => {
    const { state, router } = await go(`c/${ENG_ID}`);
    await click(within(nav()).getByRole("button", { name: "Criar canal" }));
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    const name = within(dialog).getByLabelText("Nome");
    await type(name, "eng");
    expect(dialog.textContent).toContain("Já existe um canal #eng.");
    await type(name, "Vendas Sul");
    expect((name as HTMLInputElement).value).toBe("vendas-sul");
    await type(within(dialog).getByLabelText("Descrição"), "Leads e propostas");
    await click(within(dialog).getByRole("radio", { name: /Privado/ }));
    await type(within(dialog).getByRole("searchbox", { name: "Buscar pessoa ou agente" }), "ada");
    await click(within(dialog).getByRole("checkbox", { name: /Ada/ }));
    expect(dialog.textContent).toContain("1 selecionado");
    await click(within(dialog).getByRole("button", { name: "Criar #vendas-sul" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "chat.createChannel")?.args[1]).toEqual({
      name: "vendas-sul",
      topic: "Leads e propostas",
      visibility: "private",
    });
    const created = state.channels.find((c) => c.name === "vendas-sul");
    expect(state.calls.find((c) => c.method === "chat.addMember")?.args).toEqual([
      ORG_ID,
      created?.id,
      { agentId: ADA_ID },
    ]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${created?.id}`);
  });
});

describe("Detalhes do canal: membros", () => {
  const openDetails = async () => {
    await click(screen().getByRole("button", { name: "Detalhes do canal" }));
    await settle(3);
    return screen().getByRole("dialog", { name: "#eng" });
  };

  test("toggle 'Responde sem menção' keeps the agent's other channels; remove and add members", async () => {
    const state = seedState();
    state.channelMembers[GENERAL_ID]?.push({ type: "agent", id: ATLAS_ID });
    await go(`c/${ENG_ID}`, state);
    let dialog = await openDetails();
    expect(within(dialog).getByRole("checkbox", { name: "Ada responde sem menção" })).toBeTruthy();
    const atlasAuto = within(dialog).getByRole("checkbox", { name: "Atlas responde sem menção" });
    expect(atlasAuto.getAttribute("aria-checked")).toBe("true");
    await click(atlasAuto);
    await settle(4);
    const put = state.calls.find((c) => c.method === "agents.setChannels");
    expect(put?.args[1]).toBe(ATLAS_ID);
    expect(put?.args[2]).toEqual([
      { channelId: ENG_ID, autoReply: false },
      { channelId: GENERAL_ID, autoReply: true },
    ]);
    await click(within(dialog).getByRole("button", { name: "Remover João" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.removeMember")?.args).toEqual([
      ORG_ID,
      ENG_ID,
      { userId: "u-joao" },
    ]);
    await click(within(dialog).getByRole("button", { name: "Adicionar" }));
    const add = screen().getByRole("dialog", { name: "Adicionar a #eng" });
    // Only who isn't in the channel.
    expect(
      within(add)
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("id")),
    ).toEqual(["pick-person-u-joao"]);
    await click(within(add).getByRole("checkbox", { name: /João/ }));
    await click(within(add).getByRole("button", { name: "Adicionar 1" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "chat.addMember").at(-1)?.args).toEqual([
      ORG_ID,
      ENG_ID,
      { userId: "u-joao" },
    ]);
    dialog = screen().getByRole("dialog", { name: "#eng" });
    expect(dialog.textContent).toContain("João");
  });

  test("members see it read-only", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(`c/${ENG_ID}`, state);
    const dialog = await openDetails();
    expect(within(dialog).queryByRole("button", { name: "Adicionar" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Remover/ })).toBeNull();
    expect(within(dialog).getByRole("checkbox", { name: "Ada responde sem menção" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(dialog.textContent).toContain("Só quem criou o canal e os admins mudam os membros.");
  });
});

describe("agent owner is optional", () => {
  test("Criar agente: 'Sem responsável' sends ownerUserId null, with the help text", async () => {
    const { state } = await go("agents/new");
    await pick(screen().getByRole("combobox", { name: "Responsável" }), /Sem responsável/);
    expect(document.body.textContent).toContain(
      "Sem responsável, os admins recebem os avisos e aprovam as ações sensíveis.",
    );
    await type(screen().getByLabelText("Nome"), "Iris");
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.create")?.args[1]).toMatchObject({ ownerUserId: null });
  });

  test("profile: the owner select updates the agent; the header says 'sem responsável'", async () => {
    const state = seedState();
    const { state: s } = await go(`agents/${ADA_ID}`, state);
    await pick(screen().getByRole("combobox", { name: "Responsável" }), /Sem responsável/);
    await settle(4);
    expect(s.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({ ownerUserId: null });
    expect(document.body.textContent).toContain("Dev · sem responsável · Claude Sonnet 5.5");
  });
});

describe("models by provider and the default key", () => {
  const models = [
    {
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      provider: "anthropic",
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
    },
    { id: "gpt-5", label: "GPT-5", provider: "openai", inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
  ];
  const cred = { id: "k", provider: "anthropic", label: "A", keyHint: "1", createdAt: "", revokedAt: null };

  test("availability comes from the keys (or the server's flag); suggested model per provider", () => {
    expect(modelChoices(models, [cred], false).map(([p, c]) => [p, c.map((x) => x.available)])).toEqual([
      ["anthropic", [true]],
      ["openai", [false]],
    ]);
    expect(
      modelChoices([{ ...models[1], available: true } as (typeof models)[number]], [], false)[0]?.[1][0]?.available,
    ).toBe(true);
    expect(suggestModel(models, "anthropic")).toBe("claude-sonnet-5-5");
    expect(suggestModel(models, "openai")).toBe("gpt-5");
  });

  test("Criar agente: models grouped by provider, OpenAI disabled without a key; key defaults to the workspace's", async () => {
    await go("agents/new");
    const model = screen().getByRole("combobox", { name: "Modelo" });
    model.focus();
    await act(async () => fireEvent.keyDown(model, { key: "Enter" }));
    const listbox = screen().getByRole("listbox");
    expect(listbox.textContent).toContain("Anthropic");
    expect(listbox.textContent).toContain("OpenAI");
    const gpt = within(listbox).getByRole("option", { name: /GPT-5/ });
    expect(gpt.getAttribute("aria-disabled")).toBe("true");
    expect(gpt.textContent).toContain("Adicione uma chave da OpenAI para usar");
    await act(async () => fireEvent.keyDown(listbox, { key: "Escape" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const key = screen().getByRole("combobox", { name: "Chave" });
    expect(key.textContent).toContain("Chave padrão do workspace");
  });
});

describe("agent questions (ask_user)", () => {
  test("choices answer it; 'Responder' focuses the composer; the receipt waits for your answer", async () => {
    const state = seedState();
    const question = {
      id: "q1",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: "m-1",
      messageId: "msg-q",
      text: "Faço o deploy agora ou depois das 18h?",
      choices: ["Agora", "Depois das 18h"],
      status: "open",
      answer: null,
      answeredByUserId: null,
    };
    state.messages.push({
      id: "msg-q",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-q",
      meta: { question },
      createdAt: new Date().toISOString(),
    });
    const { socket } = await go(`c/${ENG_ID}`, state);
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "question.asked", channelId: ENG_ID, threadId: "m-1", question },
      }),
    );
    await settle();
    const root = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("o login está devolvendo 401")) as HTMLElement;
    expect(root.querySelector(".ac-receipt__check")?.getAttribute("aria-label")).toBe(
      "Vista por Ada; Ada está esperando sua resposta",
    );
    const card = screen().getByRole("group", { name: "Pergunta de Ada" });
    expect(card.textContent).toContain("Faço o deploy agora ou depois das 18h?");
    expect(card.querySelector(".ac-chip--waiting")?.textContent).toBe("Esperando resposta");
    await click(within(card).getByRole("button", { name: "Responder" }));
    expect(document.activeElement).toBe(screen().getByRole("textbox", { name: /Mensagem para/ }));
    await click(within(card).getByRole("button", { name: "Depois das 18h" }));
    await settle(4);
    expect(card.textContent).toContain("Você respondeu: Depois das 18h");
    expect(card.querySelector(".ac-chip--done")?.textContent).toBe("Respondida");
    expect(state.calls.find((c) => c.method === "questions.answer")?.args).toEqual([
      ORG_ID,
      "q1",
      { choice: "Depois das 18h" },
    ]);
  });

  test("a question someone already answered (409) is explained on the card", async () => {
    const state = seedState();
    const question = {
      id: "q2",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: "m-1",
      messageId: "msg-q2",
      text: "Uso a branch main ou staging?",
      choices: ["main", "staging"],
      status: "open",
      answer: null,
      answeredByUserId: null,
    };
    state.messages.push({
      id: "msg-q2",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-q2",
      meta: { question: { ...question } },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    await settle();
    // Someone else answers on the server first; this tab still shows it open.
    const stored = state.messages.find((m) => m.id === "msg-q2")?.meta?.question as { status: string };
    stored.status = "answered";
    const card = screen().getByRole("group", { name: "Pergunta de Ada" });
    await click(within(card).getByRole("button", { name: "staging" }));
    await settle(4);
    expect(within(card).getByRole("alert").textContent).toBe("Alguém já respondeu esta pergunta.");
  });
});

describe("flat DM replies", () => {
  test("an agent reply without a thread lands in the timeline and clears the typing bar", async () => {
    const { socket, state } = await go(`dm/agent/${ADA_ID}`);
    await settle(4);
    const composer = screen().getByRole("textbox", { name: /Mensagem para/ });
    await act(async () => fireEvent.change(composer, { target: { value: "oi" } }));
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    expect(document.querySelector(".ac-typing__text")?.textContent).toBe("Ada está digitando…");
    await settle(4);
    const dm = state.dms[0];
    await act(async () =>
      socket.push({
        type: "event",
        channelId: dm?.channelId,
        event: {
          type: "message.created",
          channelId: dm?.channelId,
          messageId: "flat-1",
          message: {
            id: "flat-1",
            channelId: dm?.channelId,
            threadId: null,
            author: { type: "agent", id: ADA_ID },
            body: "Oi! Em que posso ajudar?",
            mentionedAgentIds: [],
            agentRunId: "r-flat",
            createdAt: new Date().toISOString(),
          },
        },
      }),
    );
    await settle();
    expect(document.querySelector(".ac-typing__text")).toBeNull();
    const rows = screen().getAllByRole("article");
    expect(rows[rows.length - 1]?.textContent).toContain("Oi! Em que posso ajudar?");
  });
});
