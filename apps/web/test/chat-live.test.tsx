import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
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
const composer = () => screen().getByRole("textbox", { name: /Mensagem para/ });
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

describe("agent activity in the channel", () => {
  test("mention → 'Atlas está pensando…' at once → streaming text with the cursor → final message", async () => {
    const { socket, state } = await open();
    await sendText("@atlas olha o deploy");
    expect(screen().getByText("Atlas está pensando…")).toBeTruthy();
    const thinkingRow = screen().getByText("Atlas está pensando…").closest("article");
    expect(thinkingRow?.querySelector(".ac-avatar--running")).not.toBeNull();
    await settle(4);
    const root = state.messages[state.messages.length - 1];
    const run = { threadId: root?.id, runId: "r-live", agentId: ATLAS_ID };
    await push(socket, { type: "agent.thinking", ...run });
    expect(screen().getAllByText("Atlas está pensando…")).toHaveLength(1);
    await push(socket, { type: "agent.typing", ...run });
    await push(socket, { type: "agent.delta", ...run, seq: 1, text: "Deploy ok" });
    await settle();
    expect(document.querySelector(".ac-msg--streaming")?.textContent).toContain("Deploy ok");
    await push(socket, { type: "agent.idle", ...run });
    await settle();
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
  });

  test("people typing show above the composer; our typing frames are throttled", async () => {
    const { socket } = await open();
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(document.querySelector(".channel__typing")?.textContent).toBe("João está digitando…");
    for (const v of ["o", "oi", "oi ", "oi j"])
      await act(async () => fireEvent.change(composer(), { target: { value: v } }));
    expect(socket.sent.filter((f) => (f as { type: string }).type === "typing")).toEqual([
      { type: "typing", channelId: ENG_ID },
    ]);
  });
});

describe("receipts under a person's message", () => {
  test("picked → answering → waiting approval → answered; text equivalent for screen readers", async () => {
    const { socket, state } = await open();
    await sendText("@ada e o login?");
    await settle(4);
    const root = state.messages[state.messages.length - 1];
    const receipt = () => rowsWith("e o login?")[0]?.querySelector(".ac-receipt") as HTMLElement;
    expect(receipt().getAttribute("aria-label")).toBe("Vista por Ada; Ada vai responder");
    expect(receipt().querySelectorAll(".ac-avatar--agent")).toHaveLength(1);
    const run = { threadId: root?.id, runId: "r-rc", agentId: ADA_ID };
    await push(socket, { type: "agent.run", ...run, status: "running" });
    expect(receipt().textContent).toContain("Ada está respondendo");
    await push(socket, { type: "agent.run", ...run, status: "waiting_approval" });
    expect(receipt().textContent).toContain("Ada está esperando aprovação");
    await push(socket, {
      type: "message.handled",
      messageId: root?.id,
      agentId: ADA_ID,
      runId: "r-rc",
      status: "done",
    });
    expect(receipt().getAttribute("aria-label")).toBe("Vista por Ada; Ada respondeu");
    expect(receipt().getAttribute("data-done")).toBe("true");
  });

  test("failed offers 'Tentar de novo'; nobody picked offers 'Chamar um agente'", async () => {
    const { socket, state } = await open();
    await sendText("alguém viu o erro?");
    await settle(4);
    const root = state.messages[state.messages.length - 1];
    const receipt = () => rowsWith("alguém viu o erro?")[0]?.querySelector(".ac-receipt") as HTMLElement;
    await push(socket, { type: "message.routed", messageId: root?.id, seenBy: [ADA_ID, ATLAS_ID], pickedBy: [] });
    expect(receipt().getAttribute("aria-label")).toBe("Vista por Ada e Atlas; Nenhum agente vai responder");
    await act(async () => {
      const call = within(receipt()).getByRole("button", { name: "Chamar um agente" });
      call.focus();
      fireEvent.keyDown(call, { key: "Enter" });
    });
    await act(async () => fireEvent.click(screen().getByRole("menuitem", { name: /Atlas/ })));
    await settle();
    expect((composer() as HTMLTextAreaElement).value).toBe("@atlas ");

    await push(socket, { type: "message.claimed", messageId: root?.id, agentId: ATLAS_ID });
    await push(socket, { type: "run.finished", threadId: root?.id, runId: "r-f", agentId: ATLAS_ID, status: "failed" });
    expect(receipt().textContent).toContain("Atlas não conseguiu responder");
    await act(async () => fireEvent.click(within(receipt()).getByRole("button", { name: "Tentar de novo" })));
    await settle(4);
    expect(
      state.calls.filter((c) => c.method === "chat.post").map((c) => (c.args[2] as { body: string }).body),
    ).toEqual(["alguém viu o erro?", "alguém viu o erro?"]);
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
    expect(screen().getByText("Ada está pensando…")).toBeTruthy();
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
