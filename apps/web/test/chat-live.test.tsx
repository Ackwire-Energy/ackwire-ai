import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState(), path = `c/${ENG_ID}`) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ });
const sendText = async (text: string) => {
  await act(async () => fireEvent.change(composer(), { target: { value: text } }));
  await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
};
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>, channelId = ENG_ID) =>
  act(async () => socket.push({ type: "event", channelId, event: { channelId, ...event } }));
const rowsWith = (text: string) =>
  screen()
    .queryAllByRole("article")
    .filter((a) => a.textContent?.includes(text));

describe("optimistic send", () => {
  test("appears at once as pending, then reconciles by clientId with the server copy (no duplicate)", async () => {
    let release = () => {};
    const state = seedState();
    state.holdPosts = new Promise<void>((r) => {
      release = r;
    });
    const { socket } = await open(state);
    await sendText("bom dia");
    const pending = rowsWith("bom dia");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.className).toContain("ac-msg--pending");
    expect(pending[0]?.textContent).toContain("enviando…");
    // Focus stays in the composer, which is empty again.
    expect(document.activeElement).toBe(composer());
    expect((composer() as HTMLTextAreaElement).value).toBe("");
    // The WebSocket echo (with clientId) can arrive before the HTTP response.
    const posted = state.calls.find((c) => c.method === "chat.post")?.args[2] as { clientId: string } | undefined;
    const clientId = posted?.clientId ?? "";
    await push(socket, {
      type: "message.created",
      messageId: `srv-${clientId}`,
      message: {
        id: `srv-${clientId}`,
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-walter" },
        body: "bom dia",
        mentionedAgentIds: [],
        agentRunId: null,
        clientId,
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(rowsWith("bom dia")).toHaveLength(1);
    expect(rowsWith("bom dia")[0]?.className).not.toContain("ac-msg--pending");
    await act(async () => release());
    await settle(4);
    expect(rowsWith("bom dia")).toHaveLength(1);
  });

  test("failure says 'Não enviada · Tentar de novo'; retry sends the same text", async () => {
    const state = seedState({ failPosts: true });
    await open(state);
    await sendText("vai falhar");
    await settle(4);
    const row = rowsWith("vai falhar")[0] as HTMLElement;
    expect(row.className).toContain("ac-msg--failed");
    expect(within(row).getByRole("alert").textContent).toContain("Não enviada ·");
    state.failPosts = false;
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Tentar de novo" })));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "chat.post")).toHaveLength(2);
    expect(rowsWith("vai falhar")).toHaveLength(1);
    expect(rowsWith("vai falhar")[0]?.className).not.toContain("ac-msg--failed");
  });
});

const typingBar = () => document.querySelector(".ac-typing") as HTMLElement;
/** The bar's words (without avatar initials); "" when nobody is typing. */
const bar = () => ({ textContent: typingBar().querySelector(".ac-typing__text")?.textContent ?? "" });
const lastPerson = (state: ReturnType<typeof seedState>) => state.messages[state.messages.length - 1];

describe("typing bar above the composer", () => {
  test("mention → 'Atlas está digitando…' in the bar (not a message row); first words → message at the end; bar clears", async () => {
    const { socket, state } = await open();
    await sendText("@atlas olha o deploy");
    expect(bar().textContent).toBe("Atlas está digitando…");
    expect(typingBar().querySelectorAll(".ac-typing__dots span")).toHaveLength(3);
    expect(typingBar().querySelector(".ac-avatar--agent")).not.toBeNull();
    // Not a row in the timeline.
    expect(rowsWith("Atlas está")).toHaveLength(0);
    await settle(4);
    const run = { threadId: lastPerson(state)?.id, runId: "r-live", agentId: ATLAS_ID };
    await push(socket, { type: "agent.thinking", ...run });
    expect(bar().textContent).toBe("Atlas está digitando…");
    await push(socket, { type: "agent.typing", ...run });
    await push(socket, { type: "agent.delta", ...run, seq: 1, text: "Deploy ok" });
    await settle();
    const streaming = document.querySelector(".ac-msg--streaming") as HTMLElement;
    expect(streaming.textContent).toContain("Deploy ok");
    // It's the last row of the timeline, and the bar is empty again.
    const rows = screen().getAllByRole("article");
    expect(rows[rows.length - 1]).toBe(streaming);
    expect(bar().textContent).toBe("");
    await push(socket, { type: "agent.idle", ...run });
    await settle();
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
  });

  test("groups agents and people: 'Atlas e João estão digitando…'; our typing frames are throttled", async () => {
    const { socket, state } = await open();
    await sendText("@atlas tudo certo?");
    await settle(2);
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(bar().textContent).toBe("Atlas e João estão digitando…");
    await push(socket, {
      type: "agent.delta",
      threadId: lastPerson(state)?.id,
      runId: "r-g",
      agentId: ATLAS_ID,
      seq: 1,
      text: "Sim",
    });
    await settle();
    expect(bar().textContent).toBe("João está digitando…");
    for (const v of ["o", "oi", "oi ", "oi j"])
      await act(async () => fireEvent.change(composer(), { target: { value: v } }));
    expect(socket.sent.filter((f) => (f as { type: string }).type === "typing")).toEqual([
      { type: "typing", channelId: ENG_ID },
    ]);
  });
});

describe("bottom anchoring", () => {
  test("short channels sit above the composer; new rows follow while at the bottom; scrolled up shows 'Novas mensagens'", async () => {
    const { socket } = await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    expect(log.firstElementChild?.className).toBe("channel__spacer");
    // happy-dom has no layout: fake a tall scroll area.
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    await sendText("primeira");
    await settle(3);
    expect(log.scrollTop).toBe(2000);
    // The person scrolls up.
    log.scrollTop = 100;
    await act(async () => fireEvent.scroll(log));
    await push(socket, {
      type: "message.created",
      messageId: "m-new",
      message: {
        id: "m-new",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "chegou algo novo",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(log.scrollTop).toBe(100);
    const pill = screen().getByRole("button", { name: /Novas mensagens/ });
    await act(async () => fireEvent.click(pill));
    expect(log.scrollTop).toBe(2000);
    expect(screen().queryByRole("button", { name: /Novas mensagens/ })).toBeNull();
  });
});

describe("receipts: a check with a popover", () => {
  const checkOf = (text: string) => rowsWith(text)[0]?.querySelector(".ac-receipt__check") as HTMLButtonElement;
  const icon = (b: HTMLElement) => b.querySelector("path")?.getAttribute("d");

  test("one check (will answer) → clock (answering, waiting) → two checks (answered); popover lists each agent", async () => {
    const { socket, state } = await open();
    await sendText("@ada e o login?");
    await settle(4);
    const root = lastPerson(state);
    const check = () => checkOf("e o login?");
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada; Ada vai responder");
    expect(icon(check())).toBe("m5.5 10.5 3 3 6-7");
    const run = { threadId: root?.id, runId: "r-rc", agentId: ADA_ID };
    await push(socket, { type: "agent.run", ...run, status: "running" });
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada; Ada está respondendo");
    await push(socket, { type: "agent.run", ...run, status: "waiting_approval" });
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada; Ada está esperando aprovação");
    expect(icon(check())).toBe("M10 6v4l2.6 1.8");
    await push(socket, {
      type: "message.handled",
      messageId: root?.id,
      agentId: ADA_ID,
      runId: "r-rc",
      status: "done",
    });
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada; Ada respondeu");
    expect(icon(check())).toBe("m2.5 10.5 3 3 6-7M9 13l.5.5 6-7");
    // Keyboard-openable popover; Esc closes.
    check().focus();
    await act(async () => fireEvent.click(check()));
    const pop = screen().getByRole("dialog", { name: "Agentes" });
    expect(pop.textContent).toContain("Ada");
    expect(pop.textContent).toContain("Respondeu");
    expect(pop.querySelector(".ac-avatar--agent")).not.toBeNull();
    await act(async () => fireEvent.keyDown(pop, { key: "Escape" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen().queryByRole("dialog", { name: "Agentes" })).toBeNull();
  });

  test("failure: alert icon + 'Não conseguiu responder · Tentar de novo'; nobody: 'Chamar um agente'", async () => {
    const { socket, state } = await open();
    await sendText("alguém viu o erro?");
    await settle(4);
    const root = lastPerson(state);
    const receipt = () => rowsWith("alguém viu o erro?")[0]?.querySelector(".ac-receipt") as HTMLElement;
    await push(socket, { type: "message.routed", messageId: root?.id, seenBy: [ADA_ID, ATLAS_ID], pickedBy: [] });
    expect(checkOf("alguém viu o erro?").getAttribute("aria-label")).toBe(
      "Vista por Ada e Atlas; Nenhum agente vai responder",
    );
    expect(receipt().textContent).toContain("Nenhum agente vai responder ·");
    await act(async () => {
      const call = within(receipt()).getByRole("button", { name: "Chamar um agente" });
      call.focus();
      fireEvent.keyDown(call, { key: "Enter" });
    });
    await act(async () => fireEvent.click(screen().getByRole("menuitem", { name: /Atlas/ })));
    await settle();
    expect((composer() as HTMLTextAreaElement).value).toBe("@atlas ");

    await push(socket, { type: "message.claimed", messageId: root?.id, agentId: ATLAS_ID });
    await push(socket, { type: "message.handled", messageId: root?.id, agentId: ATLAS_ID, status: "failed" });
    expect(icon(checkOf("alguém viu o erro?"))).toBe("M10 6.5v4M10 13.5v.01");
    expect(receipt().textContent).toContain("Não conseguiu responder ·");
    await act(async () => fireEvent.click(within(receipt()).getByRole("button", { name: "Tentar de novo" })));
    await settle(4);
    expect(
      state.calls.filter((c) => c.method === "chat.post").map((c) => (c.args[2] as { body: string }).body),
    ).toEqual(["alguém viu o erro?", "alguém viu o erro?"]);
  });
});

describe("regression: the router picks nobody (production #general, 'oi' after 'oi @Theo')", () => {
  test("a mention answered, then a no-mention message: no thinking shown, receipt says nobody", async () => {
    // #general with exactly one person and one agent: it is NOT a DM.
    const state = seedState();
    state.channelMembers[GENERAL_ID] = [
      { type: "person", id: "u-walter" },
      { type: "agent", id: ADA_ID },
    ];
    const { socket } = await open(state, `c/${GENERAL_ID}`);
    const pushG = (e: Record<string, unknown>) => push(socket, e, GENERAL_ID);

    await sendText("oi @ada");
    await settle(4);
    const first = lastPerson(state);
    expect(bar().textContent).toBe("Ada está digitando…");
    const run = { threadId: first?.id, runId: "r-1st", agentId: ADA_ID };
    await pushG({ type: "agent.delta", ...run, seq: 1, text: "Oi!" });
    await pushG({
      type: "message.created",
      messageId: "reply-1",
      message: {
        id: "reply-1",
        channelId: GENERAL_ID,
        threadId: first?.id,
        author: { type: "agent", id: ADA_ID },
        body: "Oi, tudo bem?",
        mentionedAgentIds: [],
        agentRunId: "r-1st",
        createdAt: new Date().toISOString(),
      },
    });
    await pushG({ type: "message.handled", messageId: first?.id, agentId: ADA_ID, runId: "r-1st", status: "done" });
    await settle();
    expect(bar().textContent).toBe("");

    await sendText("oi");
    // No mention: nothing is assumed before the router decides.
    expect(bar().textContent).toBe("");
    await settle(4);
    const second = lastPerson(state);
    expect(second?.body).toBe("oi");
    expect(rowsWith("oi")[0] && rowsWith("oi").at(-1)?.querySelector(".ac-receipt")).toBeNull();
    await pushG({ type: "message.routed", messageId: second?.id, seenBy: [ADA_ID], pickedBy: [], strategy: "router" });
    await settle();
    expect(bar().textContent).toBe("");
    const receipt = rowsWith("oi").at(-1)?.querySelector(".ac-receipt") as HTMLElement;
    expect(receipt.textContent).toContain("Nenhum agente vai responder");
    expect(receipt.querySelector(".ac-receipt__check")?.getAttribute("aria-label")).toBe(
      "Vista por Ada; Nenhum agente vai responder",
    );
    // The first message keeps its own receipt.
    const firstReceipt = rowsWith("oi @Ada")[0]?.querySelector(".ac-receipt__check");
    expect(firstReceipt?.getAttribute("aria-label")).toBe("Vista por Ada; Ada respondeu");
  });
});

describe("direct messages with an agent", () => {
  test("sidebar agent → DM via POST /dms: header with role, owner and model; empty state; the agent answers without a mention", async () => {
    const state = seedState();
    await open(state, `dm/agent/${ADA_ID}`);
    await settle(4);
    expect(state.calls.find((c) => c.method === "dms.open")?.args).toEqual([ORG_ID, { agentId: ADA_ID }]);
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(document.body.textContent).toContain("Dev · responde a João · Claude Sonnet 5.5");
    expect(screen().getByRole("link", { name: "Ver perfil" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/${ADA_ID}`,
    );
    expect(document.body.textContent).toContain(
      "Converse direto com a Ada. Peça para lembrar ou esquecer algo, ou para mudar como ela trabalha.",
    );
    // The sidebar lists the DM under "Mensagens diretas".
    await settle(4);
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(
      within(nav)
        .getAllByRole("link", { name: /Ada/ })
        .map((l) => l.getAttribute("href")),
    ).toContain(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    await sendText("lembra que deploy é só de segunda a quinta");
    expect(bar().textContent).toBe("Ada está digitando…");
  });
});

describe("memory changes and proposals in the chat", () => {
  test("'memória atualizada' card (memory.updated) with a link to what Ada knows, and Desfazer", async () => {
    const { socket, state } = await open();
    await push(socket, {
      type: "memory.updated",
      threadId: "m-1",
      agentId: ADA_ID,
      runId: "r-mem",
      update: {
        action: "remembered",
        itemId: "mem-5",
        text: "O login usa tokens de 15 minutos.",
        requestedByUserId: "u-walter",
        undo: { method: "POST", path: `/api/app/organizations/${ORG_ID}/memories/mem-5/revert` },
      },
    });
    await settle();
    const card = screen().getByRole("group", { name: "Memória atualizada por Ada" });
    expect(card.textContent).toContain("Ada lembrou");
    expect(card.textContent).toContain("O login usa tokens de 15 minutos.");
    expect(within(card).getByRole("link", { name: "O que a Ada sabe" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/${ADA_ID}/memory`,
    );
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Desfazer" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "memory.revert")?.args).toEqual([ORG_ID, "mem-5"]);
    expect(card.textContent).toContain("Desfeito");
    expect(within(card).queryByRole("button", { name: "Desfazer" })).toBeNull();
  });

  test("after a reload, cards come from meta.memoryUpdates on the agent's message", async () => {
    const state = seedState();
    state.messages.push({
      id: "msg-mem",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Pronto, esqueci.",
      mentionedAgentIds: [],
      agentRunId: "r-mem",
      meta: {
        memoryUpdates: [
          {
            action: "forgot",
            itemId: "mem-7",
            text: "O staging fica em staging.acme.com.br.",
            requestedByUserId: "u-walter",
            undo: { method: "POST", path: "/x" },
          },
        ],
      },
      createdAt: new Date().toISOString(),
    });
    await open(state);
    const card = screen().getByRole("group", { name: "Memória atualizada por Ada" });
    expect(card.textContent).toContain("Ada esqueceu");
    expect(card.querySelector(".struck")?.textContent).toBe("O staging fica em staging.acme.com.br.");
    expect(within(card).getByRole("button", { name: "Desfazer" })).toBeTruthy();
  });

  test("a proposed change (memory.updated, proposed) shows the proposal inline", async () => {
    const { socket } = await open();
    await push(socket, {
      type: "memory.updated",
      threadId: "m-1",
      agentId: ADA_ID,
      runId: "r-p",
      update: {
        action: "proposed",
        itemId: "x",
        text: "",
        requestedByUserId: "u-walter",
        proposalId: "prop-1",
        canDecide: true,
      },
    });
    await settle();
    expect(screen().getByRole("group", { name: "Proposta de mudança de Ada" })).toBeTruthy();
  });

  test("a proposal in the chat: diff inline with Aceitar / Editar / Recusar", async () => {
    const state = seedState();
    state.messages.push({
      id: "msg-prop",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-prop",
      meta: { proposalId: "prop-1" },
      createdAt: new Date().toISOString(),
    });
    await open(state);
    const card = screen().getByRole("group", { name: "Proposta de mudança de Ada" });
    expect(card.querySelectorAll(".ac-diff__line--add").length).toBeGreaterThan(0);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Editar" })));
    await act(async () =>
      fireEvent.change(within(card).getByLabelText("Texto final das instruções"), {
        target: { value: "Só PRs pequenos." },
      }),
    );
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Aceitar com ajustes" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "proposals.accept")?.args).toEqual([
      ORG_ID,
      "prop-1",
      "Só PRs pequenos.",
    ]);
    expect(card.querySelector(".ac-chip--done")?.textContent).toBe("Aceita");
  });
});
