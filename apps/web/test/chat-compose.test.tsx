import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { localMeta, quoteExcerpt, replyOf } from "@/lib/reply";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {}
});

const open = async (state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
const article = (text: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes(text)) as HTMLElement;
const pickEmoji = async (trigger: HTMLElement, name: string) => {
  await act(async () => fireEvent.click(trigger));
  await settle(1);
  const picker = screen().getByRole("dialog", { name: "Emojis" });
  await act(async () => fireEvent.click(within(picker).getByRole("button", { name })));
  await settle(3);
};

describe("composer toolbar", () => {
  test("Negrito wraps the selection in the channel composer; ⌘K makes a link, not the palette", async () => {
    await open();
    const box = composer();
    await act(async () => fireEvent.change(box, { target: { value: "olha o deploy" } }));
    box.setSelectionRange(7, 13);
    const toolbar = screen().getByRole("toolbar", { name: "Formatação" });
    await act(async () => fireEvent.click(within(toolbar).getByRole("button", { name: "Negrito" })));
    expect(composer().value).toBe("olha o **deploy**");
    composer().setSelectionRange(0, 4);
    await act(async () => fireEvent.keyDown(composer(), { key: "k", metaKey: true }));
    await settle(1);
    expect(composer().value).toBe("[olha](https://) o **deploy**");
    expect(screen().queryByRole("dialog")).toBeNull();
  });
});

describe("reactions on any message", () => {
  test("a person's message: Reagir picks an emoji, the pill shows who, a click takes it back", async () => {
    const { state } = await open();
    const msg = article("o login está devolvendo 401");
    const bar = within(msg).getByRole("toolbar", { name: "Ações da mensagem de João" });
    await pickEmoji(within(bar).getByRole("button", { name: "Reagir" }), "party popper");
    expect(state.calls.find((c) => c.method === "chat.react")?.args).toEqual([ORG_ID, "m-1", "🎉"]);
    const pills = within(article("o login está devolvendo 401")).getByRole("group", { name: "Reações" });
    const pill = within(pills).getByRole("button", { name: "você reagiu com 🎉" });
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(pill.getAttribute("title")).toBe("você reagiu com 🎉");
    expect(pill.textContent).toContain("1");
    await act(async () => fireEvent.click(pill));
    await settle(3);
    expect(state.calls.find((c) => c.method === "chat.unreact")?.args).toEqual([ORG_ID, "m-1", "🎉"]);
    expect(within(article("o login está devolvendo 401")).queryByRole("group", { name: "Reações" })).toBeNull();
  });

  test("👍 from the picker on an agent's reply is the +1 feedback; 👎 replaces it", async () => {
    const { state } = await open();
    const reply = article("Achei a causa");
    await act(async () => fireEvent.mouseEnter(reply));
    const bar = within(reply).getByRole("toolbar", { name: "Ações da mensagem de Ada" });
    await pickEmoji(within(bar).getByRole("button", { name: "Reagir" }), "thumbs up");
    expect(state.calls.find((c) => c.method === "chat.react")?.args).toEqual([ORG_ID, "m-2", "+1"]);
    const pills = within(article("Achei a causa")).getByRole("group", { name: "Reações" });
    expect(within(pills).getByRole("button", { name: "você reagiu com 👍" })).toBeTruthy();
    // The "Útil" button and the pill are the same reaction.
    expect(within(bar).getByRole("button", { name: "Útil" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Não ajudou" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.unreact")?.args).toEqual([ORG_ID, "m-2", "+1"]);
    expect(state.calls.filter((c) => c.method === "chat.react").at(-1)?.args[2]).toBe("-1");
  });

  test("live: someone else's reaction arrives over the socket with their name", async () => {
    const { socket } = await open();
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "message.reactions",
          channelId: ENG_ID,
          messageId: "m-1",
          reactions: [{ reaction: "🚀", count: 1, userIds: ["u-joao"] }],
        },
      }),
    );
    await settle(2);
    const pills = within(article("o login está devolvendo 401")).getByRole("group", { name: "Reações" });
    const pill = within(pills).getByRole("button", { name: "João reagiu com 🚀" });
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    // "+" adds another.
    expect(within(pills).getByRole("button", { name: "Adicionar reação" })).toBeTruthy();
  });
});

describe("quote reply", () => {
  test("Responder: the bar says who, Enter sends meta.replyTo, the message shows the quote", async () => {
    const { state } = await open();
    const bar = within(article("o login está devolvendo 401")).getByRole("toolbar", {
      name: "Ações da mensagem de João",
    });
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Responder" })));
    const quote = document.querySelector(".composer-quote") as HTMLElement;
    expect(quote.textContent).toContain("Respondendo a João");
    expect(quote.textContent).toContain("o login está devolvendo 401");
    await act(async () => fireEvent.change(composer(), { target: { value: "vou olhar" } }));
    await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
    await settle(4);
    const post = state.calls.find((c) => c.method === "chat.post")?.args[2] as Record<string, unknown>;
    expect(post).toMatchObject({ body: "vou olhar", replyTo: "m-1" });
    // The quote goes in the same conversation (not into the thread).
    expect(post.threadId).toBeUndefined();
    expect(document.querySelector(".composer-quote")).toBeNull();
    const sent = article("vou olhar");
    const link = within(sent).getByRole("button", { name: /^Resposta a João: @ada o login está devolvendo 401/ });
    expect(link.className).toBe("msg-quote");
  });

  test("Esc drops the quote; Responder is also in the '…' menu", async () => {
    await open();
    const bar = within(article("o login está devolvendo 401")).getByRole("toolbar", {
      name: "Ações da mensagem de João",
    });
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Responder" })));
    expect(document.querySelector(".composer-quote")).not.toBeNull();
    await act(async () => fireEvent.keyDown(composer(), { key: "Escape" }));
    expect(document.querySelector(".composer-quote")).toBeNull();
    const more = within(bar).getByRole("button", { name: "Mais ações da mensagem" });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await settle(1);
    const items = within(screen().getByRole("menu"))
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(items).toEqual(["Salvar na wiki", "Copiar link", "Responder", "Responder em thread"]);
  });

  test("quote helpers: one-line excerpt, meta read back safely", () => {
    expect(quoteExcerpt("a\n\nb   c")).toBe("a b c");
    expect(quoteExcerpt("x".repeat(300))).toHaveLength(200);
    expect(replyOf({ replyTo: { messageId: 1 } })).toBeNull();
    const meta = localMeta(
      {
        id: "m-9",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "oi\ntudo bem?",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: "",
      },
      "João",
      [{ id: "f-1", version: 1, title: "a.txt" }],
    );
    expect(replyOf(meta)).toEqual({
      messageId: "m-9",
      threadId: null,
      author: { type: "person", id: "u-joao" },
      authorName: "João",
      excerpt: "oi tudo bem?",
    });
    expect(meta.artifacts).toEqual([{ id: "f-1", version: 1, title: "a.txt" }]);
  });
});

describe("attachments", () => {
  test("a picked file uploads to this channel, shows as a chip, and goes with the message", async () => {
    const { state } = await open();
    const input = document.querySelector('.channel__composer input[type="file"]') as HTMLInputElement;
    const file = new File(["oi"], "notas.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => fireEvent.change(input));
    await settle(4);
    expect(state.calls.find((c) => c.method === "artifacts.upload")?.args.slice(1)).toEqual([
      "notas.txt",
      { channelId: ENG_ID },
    ]);
    expect(screen().getByRole("button", { name: "Remover notas.txt" })).toBeTruthy();
    // Files alone can be sent.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Enviar" })));
    await settle(4);
    const post = state.calls.find((c) => c.method === "chat.post")?.args[2] as { attachments?: string[] };
    expect(post.attachments).toHaveLength(1);
    expect(screen().queryByRole("button", { name: "Remover notas.txt" })).toBeNull();
  });
});
