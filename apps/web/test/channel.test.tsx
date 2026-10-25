import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(4);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  return { ...r, socket, state };
};

describe("Canal", () => {
  test("header, messages with agent replies inline, neutral mentions and code", async () => {
    await open();
    expect(screen().getByRole("heading", { name: "# eng" })).toBeTruthy();
    expect(screen().getByText("Código, erros e deploys · Ada e Atlas respondem aqui")).toBeTruthy();
    const log = screen().getByRole("region", { name: "Mensagens" });
    const articles = within(log).getAllByRole("article");
    const ask = articles.find((a) => a.textContent?.includes("o login está devolvendo 401"));
    expect(ask?.textContent).toContain("João");
    expect(ask?.querySelector(".ac-mention")?.textContent).toBe("@Ada");
    // Ada was asked in the channel, so her reply is in the channel.
    const reply = articles.find((a) => a.textContent?.includes("Achei a causa"));
    expect(reply?.querySelector(".ac-avatar--agent")).not.toBeNull();
    expect(reply?.querySelector("code")?.textContent).toBe("expires_at");
    // No standing footer under the composer: the hint only shows while an agent works (or the channel is locked).
    expect(document.querySelector(".ac-composer__hint")).toBeNull();
  });

  test("subscribes to the channel over the WebSocket", async () => {
    const { socket } = await open();
    expect(socket.url).toBe(`ws://localhost:3000/api/ws?orgId=${ORG_ID}`);
    expect(socket.sent).toContainEqual({ type: "subscribe", channelId: ENG_ID });
  });

  test("the composer posts with Enter and the message appears once (HTTP + event)", async () => {
    const { socket, state } = await open();
    const box = screen().getByRole("combobox", { name: "Mensagem para #eng" });
    expect(box.getAttribute("placeholder")).toBe("Mensagem para #eng · use @ para chamar um agente");
    await act(async () => fireEvent.change(box, { target: { value: "@atlas acompanha o deploy?" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.post")?.args[2]).toMatchObject({
      body: "@atlas acompanha o deploy?",
    });
    const posted = state.messages[state.messages.length - 1];
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "message.created", channelId: ENG_ID, messageId: posted?.id, message: posted },
      }),
    );
    await settle();
    expect(screen().getAllByText("acompanha o deploy?", { exact: false })).toHaveLength(1);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  test("streams an agent reply with the running ring and cursor, then shows the final message", async () => {
    const { socket } = await open();
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    // Asked in the channel: it answers there, its events carry no thread.
    const run = { threadId: null, runId: "r-9", agentId: ATLAS_ID };
    await ev({ type: "agent.run", ...run, status: "running" });
    await ev({ type: "agent.delta", ...run, seq: 1, text: "Os 401 no Sentry caíram de 312 para" });
    await settle();
    const streaming = document.querySelector(".ac-msg--streaming");
    expect(streaming?.textContent).toContain("Atlas");
    expect(streaming?.textContent).toContain("escrevendo…");
    expect(streaming?.textContent).toContain("Os 401 no Sentry caíram de 312 para");
    expect(streaming?.querySelector(".ac-avatar--running")).not.toBeNull();
    // The sidebar shows the ring too.
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(nav.querySelector(".ac-avatar--running")).not.toBeNull();

    await ev({
      type: "message.created",
      messageId: "m-final",
      message: {
        id: "m-final",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ATLAS_ID },
        body: "Os 401 no Sentry caíram de 312 para 4.",
        mentionedAgentIds: [],
        agentRunId: "r-9",
        createdAt: new Date().toISOString(),
      },
    });
    await ev({ type: "agent.run", ...run, status: "done" });
    await settle();
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
    expect(screen().getByText("Os 401 no Sentry caíram de 312 para 4.")).toBeTruthy();
  });

  test("a failed run explains why", async () => {
    const { socket } = await open();
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "agent.run",
          channelId: ENG_ID,
          threadId: null,
          runId: "r-x",
          agentId: ATLAS_ID,
          status: "failed",
          error: "budget_exceeded",
        },
      }),
    );
    await settle();
    expect(screen().getByRole("alert").textContent).toContain("Atlas não conseguiu responder: budget_exceeded");
  });

  test("the inline approval card: approve calls the API, shrinks to one line; events update it", async () => {
    const r0 = await open();
    const { state, socket } = r0;
    // The card lives on the agent message with meta.approvalId.
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.closest("article")?.textContent).toContain("Ada");
    expect(card.textContent).toContain("Ada pede aprovação");
    expect(card.querySelector(".ac-chip--waiting")?.textContent).toBe("Aguardando você");
    expect(card.textContent).toContain("Merge PR #42 into main");
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Aprovar merge" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args).toEqual([ORG_ID, "ap-merge", undefined]);
    const done = screen().getByRole("group", { name: "Aprovação concluída" });
    expect(done.textContent).toContain("Aprovado por você · agora");
    // Someone else refuses another approval: the event updates the card live.
    const deploy = {
      ...state.approvals[1],
      status: "refused",
      decidedByUserId: "u-joao",
      decidedAt: new Date().toISOString(),
    };
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "approval.decided", channelId: ENG_ID, approval: deploy },
      }),
    );
    await settle();
    const list = (await r0.services.queryClient.getQueryData(["org", ORG_ID, "approvals"])) as {
      id: string;
      status: string;
    }[];
    expect(list.find((a) => a.id === "ap-deploy")?.status).toBe("refused");
  });

  test("not a member of a public channel: join instead of the composer", async () => {
    const state = seedState();
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) eng.isMember = false;
    await open(state);
    expect(screen().queryByRole("textbox", { name: "Mensagem para #eng" })).toBeNull();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Entrar no #eng" })));
    await settle(4);
    expect(state.calls.some((c) => c.method === "chat.join")).toBe(true);
    expect(screen().getByRole("combobox", { name: "Mensagem para #eng" })).toBeTruthy();
  });

  test("channel details: agents and people in groups, no search on a short list", async () => {
    await open();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Detalhes do canal" })));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    expect(dialog.textContent).toContain("Agentes");
    expect(dialog.textContent).toContain("Pessoas");
    expect(dialog.textContent).toContain("João");
    expect(dialog.textContent).toContain("Entra na conversa sozinho");
    expect(within(dialog).queryByRole("searchbox", { name: "Buscar pessoa ou agente" })).toBeNull();
  });

  test("agent replies: 👍/👎 toggle with the API and Corrigir resposta sends a correction", async () => {
    const { state } = await open();
    const reply = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Achei a causa")) as HTMLElement;
    await act(async () => fireEvent.mouseEnter(reply));
    const bar = within(reply).getByRole("toolbar", { name: "Ações da mensagem de Ada" });
    const up = within(bar).getByRole("button", { name: "Útil" });
    expect(up.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(up));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.react")?.args).toEqual([ORG_ID, "m-2", "+1"]);
    expect(within(bar).getByRole("button", { name: "Útil" }).getAttribute("aria-pressed")).toBe("true");
    // 👎 replaces 👍.
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Não ajudou" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.unreact")?.args).toEqual([ORG_ID, "m-2", "+1"]);
    expect(state.calls.filter((c) => c.method === "chat.react").at(-1)?.args[2]).toBe("-1");
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Corrigir resposta" })));
    const dialog = screen().getByRole("dialog", { name: "Corrigir a resposta da Ada" });
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Como deveria ser"), {
        target: { value: "O token expira em 15 min." },
      }),
    );
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Enviar correção" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.correct")?.args).toEqual([
      ORG_ID,
      "m-2",
      "O token expira em 15 min.",
    ]);
    expect(document.body.textContent).toContain("Correção enviada. A Ada vai aprender com ela.");
  });

  test("people's messages have no feedback buttons: Reagir, Responder and '…'", async () => {
    await open();
    const ask = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("o login está devolvendo 401")) as HTMLElement;
    const bar = within(ask).getByRole("toolbar", { name: "Ações da mensagem de João" });
    expect(within(bar).queryByRole("button", { name: "Útil" })).toBeNull();
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Reagir", "Responder", "Mais ações da mensagem"]);
  });

  test("admins edit the channel topic from the details", async () => {
    const { state } = await open();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Detalhes do canal" })));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Descrição do canal"), { target: { value: "Código e deploys" } }),
    );
    // Saves on blur, without a button.
    await act(async () => fireEvent.blur(within(dialog).getByLabelText("Descrição do canal")));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.update")?.args[2]).toEqual({ topic: "Código e deploys" });
  });
});
