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
    // Ada's reply lives in the thread of João's message and shows inline.
    const reply = articles.find((a) => a.textContent?.includes("Achei a causa"));
    expect(reply?.querySelector(".ac-avatar--agent")).not.toBeNull();
    expect(reply?.querySelector("code")?.textContent).toBe("expires_at");
    expect(
      screen().getByText("Ada e Atlas leem este canal. Merge, deploy e rollback sempre pedem sua aprovação."),
    ).toBeTruthy();
  });

  test("subscribes to the channel over the WebSocket", async () => {
    const { socket } = await open();
    expect(socket.url).toBe(`ws://localhost:3000/api/ws?orgId=${ORG_ID}`);
    expect(socket.sent).toContainEqual({ type: "subscribe", channelId: ENG_ID });
  });

  test("the composer posts with Enter and the message appears once (HTTP + event)", async () => {
    const { socket, state } = await open();
    const box = screen().getByRole("textbox", { name: "Mensagem para #eng" });
    expect(box.getAttribute("placeholder")).toBe("Mensagem para #eng · use @ para chamar um agente");
    await act(async () => fireEvent.change(box, { target: { value: "@atlas acompanha o deploy?" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.post")?.args[2]).toEqual({ body: "@atlas acompanha o deploy?" });
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
    const run = { threadId: "m-1", runId: "r-9", agentId: ATLAS_ID };
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
        threadId: "m-1",
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
          threadId: "m-1",
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

  test("the inline approval card: approve shrinks it to one line with who decided", async () => {
    await open();
    const card = screen()
      .getAllByRole("group", { name: "Pedido de aprovação" })
      .find((g) => g.textContent?.includes("Ada pede aprovação")) as HTMLElement;
    expect(card.textContent).toContain("Ada pede aprovação");
    expect(card.querySelector(".ac-chip--waiting")?.textContent).toBe("Aguardando você");
    expect(card.textContent).toContain("Fazer merge do PR #42 em main");
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Aprovar merge" })));
    await settle(4);
    const done = screen().getAllByRole("group", { name: "Aprovação concluída" });
    expect(done.some((g) => g.textContent?.includes("Aprovado por você · agora"))).toBe(true);
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
    expect(screen().getByRole("textbox", { name: "Mensagem para #eng" })).toBeTruthy();
  });

  test("channel details: searchable list of people and agents", async () => {
    await open();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Detalhes do canal" })));
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    expect(dialog.textContent).toContain("João");
    expect(dialog.textContent).toContain("@atlas");
    await act(async () =>
      fireEvent.change(within(dialog).getByRole("searchbox", { name: "Buscar pessoa ou agente" }), {
        target: { value: "zzz" },
      }),
    );
    expect(dialog.textContent).toContain("Ninguém encontrado com “zzz”.");
  });
});
