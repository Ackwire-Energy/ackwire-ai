import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
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
    expect(within(row).getByRole("alert").textContent).toBe("Não enviada·Tentar de novo");
    state.failPosts = false;
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Tentar de novo" })));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "chat.post")).toHaveLength(2);
    expect(rowsWith("vai falhar")).toHaveLength(1);
    expect(rowsWith("vai falhar")[0]?.className).not.toContain("ac-msg--failed");
  });

  test("the server restarting (the proxy's 502): it waits instead of failing, then goes out by itself with its clientId", async () => {
    const state = seedState({ failPosts: new ApiError(502, "http_502", "Bad Gateway") });
    const { sockets } = await open(state);
    await sendText("durante o deploy");
    await settle(4);
    const row = () => rowsWith("durante o deploy")[0] as HTMLElement;
    expect(row().className).not.toContain("ac-msg--failed");
    expect(row().textContent).toContain("sai quando a conexão voltar");
    // The new server is up: the socket drops with the old one and reconnects.
    state.failPosts = false;
    await act(async () => sockets.last().drop());
    await act(() => new Promise((r) => setTimeout(r, 650)));
    await act(async () => sockets.last().open());
    await settle(4);
    const clientIds = state.calls
      .filter((c) => c.method === "chat.post")
      .map((c) => (c.args[2] as { clientId: string }).clientId);
    expect(clientIds).toHaveLength(2);
    expect(clientIds[0]).toBeTruthy();
    expect(clientIds[1]).toBe(clientIds[0]);
    expect(rowsWith("durante o deploy")).toHaveLength(1);
    expect(row().className).not.toContain("ac-msg--pending");
    expect(row().className).not.toContain("ac-msg--failed");
  });

  test("a message waiting in one conversation goes out once the server is back, while the person is in another", async () => {
    const state = seedState({ failPosts: new ApiError(502, "http_502", "Bad Gateway") });
    const { sockets, router } = await open(state);
    const go = (channelId: string) =>
      act(() => router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId } }));
    await sendText("antes do deploy");
    await settle(4);
    expect(rowsWith("antes do deploy")[0]?.textContent).toContain("sai quando a conexão voltar");
    await go(GENERAL_ID);
    await settle(4);
    state.failPosts = false;
    await act(async () => sockets.last().drop());
    await act(() => new Promise((r) => setTimeout(r, 650)));
    await act(async () => sockets.last().open());
    await settle(4);
    const posts = () =>
      state.calls
        .filter((c) => c.method === "chat.post")
        .map((c) => `${c.args[1]}:${(c.args[2] as { clientId: string }).clientId}`);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toBe(posts()[0] as string);
    // Back in that conversation: the message is there, sent, and nothing goes out again.
    await go(ENG_ID);
    await settle(4);
    expect(rowsWith("antes do deploy")).toHaveLength(1);
    expect(rowsWith("antes do deploy")[0]?.className).not.toContain("ac-msg--failed");
    expect(rowsWith("antes do deploy")[0]?.className).not.toContain("ac-msg--pending");
    expect(posts()).toHaveLength(2);
  });
});

const typingBar = () => document.querySelector(".ac-typing") as HTMLElement;
/** The bar's words (without avatar initials); "" when nobody is typing. */
const bar = () => ({ textContent: typingBar().querySelector(".ac-typing__text")?.textContent ?? "" });
const lastPerson = (state: ReturnType<typeof seedState>) => state.messages[state.messages.length - 1];

describe("typing bar above the composer", () => {
  test("mention → 'Atlas está trabalhando…'; its block from the start, last in the timeline", async () => {
    const { socket } = await open();
    await sendText("@atlas olha o deploy");
    expect(bar().textContent).toBe("Atlas está trabalhando…");
    // Agents at work: the pixel orbit (the dots are for people typing).
    expect(typingBar().querySelector(".ac-pixspin")).not.toBeNull();
    expect(typingBar().querySelector(".ac-typing__dots")).toBeNull();
    expect(typingBar().querySelector(".ac-avatar--agent")).not.toBeNull();
    // The words are the bar's; the block in the timeline opens with a short phrase.
    expect(rowsWith("Atlas está")).toHaveLength(0);
    await settle(4);
    const run = { threadId: null, runId: "r-live", agentId: ATLAS_ID };
    await push(socket, { type: "agent.thinking", ...run });
    expect(bar().textContent).toBe("Atlas está trabalhando…");
    await push(socket, { type: "agent.typing", ...run });
    await push(socket, { type: "agent.delta", ...run, seq: 1, text: "Deploy ok" });
    await settle();
    const streaming = document.querySelector(".ac-msg--streaming") as HTMLElement;
    expect(streaming.textContent).toContain("Deploy ok");
    // It's the last row of the timeline; the card above the box stays on while it works.
    const rows = screen().getAllByRole("article");
    expect(rows[rows.length - 1]).toBe(streaming);
    expect(bar().textContent).toBe("Atlas está escrevendo…");
    await push(socket, { type: "agent.idle", ...run });
    await settle();
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
  });

  test("groups agents and people: 'Atlas está trabalhando · João está digitando…'; our typing frames are throttled", async () => {
    const { socket } = await open();
    await sendText("@atlas tudo certo?");
    await settle(2);
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(bar().textContent).toBe("Atlas está trabalhando · João está digitando…");
    await push(socket, {
      type: "agent.delta",
      threadId: null,
      runId: "r-g",
      agentId: ATLAS_ID,
      seq: 1,
      text: "Sim",
    });
    await settle();
    // Atlas writes now; it stays on the card while it works.
    expect(bar().textContent).toBe("Atlas está escrevendo · João está digitando…");
    for (const v of ["o", "oi", "oi ", "oi j"])
      await act(async () => fireEvent.change(composer(), { target: { value: v } }));
    expect(socket.sent.filter((f) => (f as { type: string }).type === "typing")).toEqual([
      { type: "typing", channelId: ENG_ID },
    ]);
  });

  test("someone typing alone: the dots, their face and 'João está digitando…', gone once their message comes", async () => {
    const { socket } = await open();
    expect(typingBar().dataset.active).toBe("false");
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(typingBar().dataset.active).toBe("true");
    expect(bar().textContent).toBe("João está digitando…");
    // People only: the typing dots lead (the orbit is for agents), their face in the stack, no clock and no stop.
    expect(typingBar().querySelector(".ac-typing__dots")).not.toBeNull();
    expect(typingBar().querySelector(".ac-pixspin")).toBeNull();
    expect(typingBar().querySelectorAll(".ac-typing__tok .ac-avatar")).toHaveLength(1);
    expect(typingBar().querySelector(".ac-typing__elapsed, .stop-run")).toBeNull();
    await push(socket, {
      type: "message.created",
      messageId: "m-joao",
      message: {
        id: "m-joao",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "pronto, subiu",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(typingBar().dataset.active).toBe("false");
  });

  test("my own typing never shows, and someone typing in a thread shows in that thread, not here", async () => {
    const { socket } = await open();
    await push(socket, { type: "user.typing", userId: "u-walter", threadId: null, ttlMs: 6000 });
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: "m-1", ttlMs: 6000 });
    await settle();
    expect(typingBar().dataset.active).toBe("false");
  });

  test("in a thread: who types there shows (not who types in the channel), and my typing frames name the thread", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.threads.create(ORG_ID, {
      id: "m-1",
      channelId: ENG_ID,
      firstMessageId: "m-1",
      lastMessageId: "m-1",
      title: "Login com 401",
    } as Parameters<typeof api.threads.create>[1]);
    const { sockets } = await renderApp(`/org/${ORG_ID}/threads/m-1`, { api });
    await settle(8);
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(typingBar().dataset.active).toBe("false");
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: "m-1", ttlMs: 6000 });
    await settle();
    expect(bar().textContent).toBe("João está digitando…");
    const reply = screen().getByRole("combobox", { name: /Responder na thread/ });
    await act(async () => fireEvent.change(reply, { target: { value: "vou olhar" } }));
    expect(socket.sent.filter((f) => (f as { type: string }).type === "typing")).toEqual([
      { type: "typing", channelId: ENG_ID, threadId: "m-1" },
    ]);
  });

  test("several agents and people: one short line, three small faces at most, no clock or stop", async () => {
    const { socket } = await open();
    const a = { threadId: null, runId: "r-a", agentId: ADA_ID };
    await push(socket, {
      type: "agent.run",
      ...a,
      status: "running",
      startedAt: new Date(Date.now() - 13_000).toISOString(),
    });
    await push(socket, { type: "agent.tool", ...a, tool: "github_list_prs" });
    await push(socket, { type: "agent.run", threadId: null, runId: "r-b", agentId: ATLAS_ID, status: "running" });
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(bar().textContent).toBe("Ada e Atlas estão trabalhando · João está digitando…");
    expect(typingBar().querySelectorAll(".ac-typing__tok")).toHaveLength(3);
    expect(typingBar().querySelector(".ac-pixspin")).not.toBeNull();
    // The time, "Ver" and the stop are one agent's: with two at work the line shows none (the composer still stops).
    expect(typingBar().querySelector(".ac-typing__elapsed")).toBeNull();
    expect(within(typingBar()).queryByRole("button", { name: "Ver" })).toBeNull();
    expect(within(typingBar()).queryByRole("button", { name: "Parar" })).toBeNull();
    // One leaves: the other gets its own line back, with its time.
    await push(socket, { type: "agent.idle", threadId: null, runId: "r-b", agentId: ATLAS_ID });
    await push(socket, { type: "run.finished", threadId: null, runId: "r-b", agentId: ATLAS_ID, status: "done" });
    await settle();
    expect(bar().textContent).toBe("Ada está consultando o GitHub · João está digitando…");
    const took = typingBar().querySelector(".ac-typing__elapsed") as HTMLElement;
    expect(took.textContent).toMatch(/^1\d s$/);
    // Tabular figures: the seconds tick without nudging what is beside them.
    expect(took.classList.contains("ac-num")).toBe(true);
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
    await act(async () => {
      fireEvent.wheel(log);
      fireEvent.scroll(log);
    });
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

  test("a small scroll up lets go at once: new messages don't pull it back down", async () => {
    const { socket } = await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    await sendText("primeira");
    await settle(3);
    expect(log.scrollTop).toBe(2000);
    // A browser reports the scroll to the bottom too (happy-dom doesn't on its own).
    await act(async () => fireEvent.scroll(log));
    // Still inside the "near bottom" band, but moving up.
    log.scrollTop = 1960;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: -40 });
      fireEvent.scroll(log);
    });
    await push(socket, {
      type: "message.created",
      messageId: "m-near",
      message: {
        id: "m-near",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "mais uma",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(log.scrollTop).toBe(1960);
    expect(screen().getByRole("button", { name: /Novas mensagens/ })).not.toBeNull();
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
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada vai responder");
    expect(icon(check())).toBe("m5.5 10.5 3 3 6-7");
    const run = { threadId: root?.id, runId: "r-rc", agentId: ADA_ID };
    await push(socket, { type: "agent.run", ...run, status: "running" });
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada está respondendo");
    await push(socket, { type: "agent.run", ...run, status: "waiting_approval" });
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada está esperando aprovação");
    expect(icon(check())).toBe("M10 6v4l2.6 1.8");
    await push(socket, {
      type: "message.handled",
      messageId: root?.id,
      agentId: ADA_ID,
      runId: "r-rc",
      status: "done",
    });
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada respondeu");
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

  test("failure: alert icon + 'Não conseguiu responder · Tentar de novo'; nobody: 'Chamar um agente', each by its face", async () => {
    const seeded = seedState();
    const [ada, atlas] = seeded.agents;
    if (ada) ada.appearance = { color: "green", eyes: "happy", accessory: "headphones" };
    if (atlas) atlas.appearance = { color: "rose", eyes: "sleepy", accessory: "crown" };
    const { socket, state } = await open(seeded);
    await sendText("alguém viu o erro?");
    await settle(4);
    const root = lastPerson(state);
    const receipt = () => rowsWith("alguém viu o erro?")[0]?.querySelector(".ac-receipt") as HTMLElement;
    await push(socket, { type: "message.routed", messageId: root?.id, seenBy: [ADA_ID, ATLAS_ID], pickedBy: [] });
    expect(checkOf("alguém viu o erro?").getAttribute("aria-label")).toBe(
      "Vista por Ada e Atlas. Nenhum agente vai responder",
    );
    expect(receipt().textContent).toContain("Nenhum agente vai responder·Chamar um agente");
    await act(async () => {
      const call = within(receipt()).getByRole("button", { name: "Chamar um agente" });
      call.focus();
      fireEvent.keyDown(call, { key: "Enter" });
    });
    // Each agent leads with its own face (its look), not one glyph for all.
    const menu = screen().getByRole("menu");
    const face = (name: RegExp) =>
      within(menu).getByRole("menuitem", { name }).querySelector(":scope > .ac-menu__leading > .ac-avatar--agent");
    expect([face(/Ada/)?.getAttribute("data-eyes"), face(/Ada/)?.getAttribute("data-accessory")]).toEqual([
      "happy",
      "headphones",
    ]);
    expect([face(/Atlas/)?.getAttribute("data-eyes"), face(/Atlas/)?.getAttribute("data-accessory")]).toEqual([
      "sleepy",
      "crown",
    ]);
    expect(menu.querySelector(".ac-menu__item > .ac-icon")).toBeNull();
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: /Atlas/ })));
    await settle();
    expect((composer() as HTMLTextAreaElement).value).toBe("@atlas ");

    await push(socket, { type: "message.claimed", messageId: root?.id, agentId: ATLAS_ID });
    await push(socket, { type: "message.handled", messageId: root?.id, agentId: ATLAS_ID, status: "failed" });
    expect(icon(checkOf("alguém viu o erro?"))).toBe("M10 6.5v4M10 13.5v.01");
    expect(receipt().textContent).toContain("Não conseguiu responder·Tentar de novo");
    await act(async () => fireEvent.click(within(receipt()).getByRole("button", { name: "Tentar de novo" })));
    await settle(4);
    expect(
      state.calls.filter((c) => c.method === "chat.post").map((c) => (c.args[2] as { body: string }).body),
    ).toEqual(["alguém viu o erro?", "alguém viu o erro?"]);
  });
});

describe("receipts: who picked the agents for a message nobody mentioned", () => {
  const receiptOf = (text: string) => rowsWith(text)[0]?.querySelector(".ac-receipt") as HTMLElement;
  const popoverOf = async (text: string) => {
    await act(async () => fireEvent.click(receiptOf(text).querySelector(".ac-receipt__check") as HTMLElement));
    return screen().getByRole("dialog", { name: "Agentes" });
  };
  const closePopover = async (pop: HTMLElement) => {
    await act(async () => fireEvent.keyDown(pop, { key: "Escape" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
  };

  test("no step could pick: 'sem @' with why behind its ⓘ and Chamar um agente; the popover says how agents are picked", async () => {
    const { socket, state } = await open();
    await sendText("alguém sabe?");
    await settle(4);
    const root = lastPerson(state);
    await push(socket, {
      type: "message.routed",
      messageId: root?.id,
      seenBy: [ADA_ID, ATLAS_ID],
      pickedBy: [],
      strategy: "router",
      reason: "mention_needed",
    });
    const receipt = receiptOf("alguém sabe?");
    expect(receipt.querySelector(".ac-receipt__check")?.getAttribute("aria-label")).toBe(
      "Vista por Ada e Atlas. Nenhum agente vai responder sem @",
    );
    const hint = within(receipt).getByRole("button", { name: "Sobre Quem escolhe os agentes" });
    expect(document.getElementById(hint.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Nenhuma IA aqui conseguiu escolher um agente para esta mensagem. Mencione um agente para chamá-lo.",
    );
    expect(within(receipt).getByRole("button", { name: "Chamar um agente" })).toBeTruthy();
    expect(receipt.textContent).toContain("Nenhum agente vai responder sem @");
    // The dot right after the ⓘ's line, which the kit draws closer (its circle stops inside its box), one piece with
    // its action.
    expect(receipt.querySelector(".ac-hintline + .ac-receipt__then > .ac-receipt__dot")?.textContent).toBe("·");
    const pop = await popoverOf("alguém sabe?");
    expect(within(pop).getByRole("link", { name: "Como os agentes são escolhidos" }).getAttribute("href")).toBe(
      "https://app.agentes.chat/help/who-answers?lang=pt-BR",
    );
    // Nobody picked: no line naming who did.
    expect(pop.querySelectorAll(".who-by")).toHaveLength(1);
  });

  test("'Escolhendo quem responde': the clock where the check goes while the author's plan reads it, then who picked", async () => {
    const { socket, state } = await open();
    await sendText("revisa o PR?");
    await settle(4);
    const root = lastPerson(state);
    await push(socket, { type: "message.routing", messageId: root?.id, step: "plan" });
    // A mark, not a line: its words are its name and its popover's line, with "Chamar um agente".
    const clock = receiptOf("revisa o PR?").querySelector(".ac-receipt__check") as HTMLElement;
    expect(clock.getAttribute("aria-label")).toBe("Escolhendo quem responde");
    expect(clock.querySelector("path")?.getAttribute("d")).toBe("M10 6v4l2.6 1.8");
    expect(rowsWith("revisa o PR?")[0]?.querySelector(".ac-msg__foot")?.textContent).toBe("");
    const picking = await popoverOf("revisa o PR?");
    expect(picking.querySelector(".who-by")?.textContent).toBe("Escolhendo quem responde·Chamar um agente");
    await act(async () => {
      const call = within(picking).getByRole("button", { name: "Chamar um agente" });
      call.focus();
      fireEvent.keyDown(call, { key: "Enter" });
    });
    await act(async () => fireEvent.click(screen().getByRole("menuitem", { name: /Atlas/ })));
    await settle();
    expect((composer() as HTMLTextAreaElement).value).toBe("@atlas ");
    await closePopover(picking);
    await push(socket, {
      type: "message.routed",
      messageId: root?.id,
      seenBy: [ADA_ID, ATLAS_ID],
      pickedBy: [ADA_ID],
      strategy: "router",
      decidedBy: { step: "plan", brand: "claude", ownerId: "u-walter" },
    });
    // The check takes the clock's place.
    const check = receiptOf("revisa o PR?").querySelector(".ac-receipt__check") as HTMLElement;
    expect(check.getAttribute("aria-label")).toBe("Vista por Ada e Atlas. Ada vai responder");
    expect(check.querySelector("path")?.getAttribute("d")).toBe("m5.5 10.5 3 3 6-7");
    const pop = await popoverOf("revisa o PR?");
    expect(pop.textContent).not.toContain("Escolhendo");
    const by = pop.querySelector(".who-by") as HTMLElement;
    expect(by.textContent).toBe("Escolhido pelo seu plano do Claude");
    expect(by.querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("claude");
    // Under the agents, as the popover's last line.
    expect(pop.lastElementChild).toBe(by);
  });

  test("the popover's last line names who picked, with its mark or our icon; a decision for nobody or from before says nothing", async () => {
    const { socket, state } = await open();
    const cases: [Record<string, unknown>, string, string | null][] = [
      [{ step: "jev" }, "Escolhido pelo Jev", "typesafe"],
      [
        { step: "model", model: "claude-haiku-5-5", provider: "anthropic" },
        "Escolhido pelo Claude Haiku 5.5",
        "claude",
      ],
      [{ step: "plan", brand: "chatgpt", ownerId: "u-joao" }, "Escolhido pelo plano do ChatGPT de João", "openai"],
      [{ step: "rule", rule: "reply" }, "Uma resposta para a Ada", null],
      [{ step: "rule", rule: "only_agent" }, "Só a Ada responde aqui sem menção", null],
      [{ step: "rule", rule: "follow_up" }, "Segue a conversa com a Ada", null],
    ];
    for (const [i, [decidedBy, words, mark]] of cases.entries()) {
      const text = `pergunta ${i + 1}`;
      await sendText(text);
      await settle(4);
      await push(socket, {
        type: "message.routed",
        messageId: lastPerson(state)?.id,
        seenBy: [ADA_ID],
        pickedBy: [ADA_ID],
        strategy: "router",
        decidedBy,
      });
      const pop = await popoverOf(text);
      const by = pop.querySelector(".who-by") as HTMLElement;
      expect([text, by.textContent]).toEqual([text, words]);
      expect(by.className).toContain("ac-iconline");
      if (mark) expect(by.querySelector(".ac-brand")?.getAttribute("data-mark")).toBe(mark);
      else expect(by.firstElementChild?.classList.contains("ac-icon")).toBe(true);
      await closePopover(pop);
    }
    for (const [text, routed] of [
      ["ninguém pegou", { pickedBy: [], decidedBy: { step: "jev" } }],
      ["de antes", { pickedBy: [ADA_ID] }],
    ] as const) {
      await sendText(text);
      await settle(4);
      await push(socket, { type: "message.routed", messageId: lastPerson(state)?.id, seenBy: [ADA_ID], ...routed });
      const pop = await popoverOf(text);
      expect([text, pop.querySelector(".who-by")]).toEqual([text, null]);
      await closePopover(pop);
    }
    expect(receiptOf("ninguém pegou").textContent).toContain("Nenhum agente vai responder·Chamar um agente");
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
    expect(bar().textContent).toBe("Ada está trabalhando…");
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
      "Vista por Ada. Nenhum agente vai responder",
    );
    // The first message keeps its own receipt.
    const firstReceipt = rowsWith("oi @Ada")[0]?.querySelector(".ac-receipt__check");
    expect(firstReceipt?.getAttribute("aria-label")).toBe("Vista por Ada. Ada respondeu");
  });
});

describe("empty conversations", () => {
  test("a channel: its greeting and the suggestions; a DM with a person: the greeting alone", async () => {
    await open(seedState(), `c/${GENERAL_ID}`);
    await settle(4);
    const channel = document.querySelector(".ac-empty") as HTMLElement;
    expect(channel.querySelector(".ac-empty__title")?.textContent).toBe("Diga oi em #general");
    expect(channel.querySelector(".ac-empty__text")).toBeNull();
    cleanup();
    await open(seedState(), "dm/person/u-joao");
    await settle(4);
    const dm = document.querySelector(".ac-empty") as HTMLElement;
    expect(dm.querySelector(".ac-empty__title")?.textContent).toBe("Diga oi para João");
    expect(dm.querySelector(".ac-empty__text")).toBeNull();
  });

  test("a channel's suggestions go to the first agent with a handle someone chose, by name; with none, to the first agent", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (!ada) throw new Error("no Ada");
    const imported = "00000000-0000-4000-8000-0000000000a9";
    const alsoImported = "00000000-0000-4000-8000-0000000000aa";
    state.agents.push(
      { ...ada, id: imported, name: "New agent", handle: "agent-e9665a97-c8d5-423f-ae59-25", role: "" },
      { ...ada, id: alsoImported, name: "Rita Revisão", handle: "agent-925ca021-21e4-4053-9e0a-23", role: "" },
    );
    state.channelMembers[GENERAL_ID] = [
      { type: "person", id: "u-walter" },
      { type: "agent", id: imported },
      { type: "agent", id: ADA_ID },
    ];
    await open(state, `c/${GENERAL_ID}`);
    await settle(4);
    const suggestion = screen().getByRole("button", { name: "@Ada O que quebrou desde o último deploy?" });
    expect(document.querySelector(".channel__suggestions")?.textContent).not.toContain("agent-");
    await act(async () => fireEvent.click(suggestion));
    expect((composer() as HTMLTextAreaElement).value).toBe("@ada O que quebrou desde o último deploy?");
    cleanup();

    state.channelMembers[GENERAL_ID] = [
      { type: "person", id: "u-walter" },
      { type: "agent", id: imported },
      { type: "agent", id: alsoImported },
    ];
    await open(state, `c/${GENERAL_ID}`);
    await settle(4);
    await act(async () =>
      fireEvent.click(screen().getByRole("button", { name: "@New agent Oi, o que você sabe fazer?" })),
    );
    expect((composer() as HTMLTextAreaElement).value).toBe(
      "@agent-e9665a97-c8d5-423f-ae59-25 Oi, o que você sabe fazer?",
    );
  });
});

test("a DM's head: the name with a line under it rises to the face's top, a person's as an agent's", async () => {
  await open(seedState(), "dm/person/u-joao");
  await settle(4);
  const person = screen().getByRole("heading", { level: 1, name: "João" });
  expect(person.className).toBe("channel__title ac-captop");
  expect(person.nextElementSibling?.textContent).toBe("joao@acme.com.br");
  cleanup();
  await open(seedState(), `dm/agent/${ADA_ID}`);
  await settle(4);
  expect(screen().getByRole("heading", { level: 1, name: "Ada" }).className).toBe("channel__title ac-captop");
});

describe("direct messages with an agent", () => {
  test("empty DM: 'Diga oi para a Ada' with first messages from her role; one goes to the composer", async () => {
    await open(seedState(), `dm/agent/${ADA_ID}`);
    await settle(4);
    expect(document.body.textContent).toContain("Diga oi para a Ada");
    const suggestion = screen().getByRole("button", { name: "O que quebrou desde o último deploy?" });
    await act(async () => fireEvent.click(suggestion));
    expect((composer() as HTMLTextAreaElement).value).toBe("O que quebrou desde o último deploy?");
    expect(document.activeElement).toBe(composer());
  });

  test("a computer brain thinks for the agent: the DM header says Claude Code · Sonnet no MacBook, with its mark", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "claude_code", model: "Sonnet", computer: "MacBook" };
    await open(state, `dm/agent/${ADA_ID}`);
    await settle(4);
    expect(document.body.textContent).toContain("Dev · de João · Claude Code · Sonnet no MacBook");
    expect(document.body.textContent).not.toContain("Claude Sonnet 5.5");
    const brain = document.querySelector(".channel__brain") as HTMLElement;
    expect(brain.querySelector(".ac-brand[data-mark='claude']")).not.toBeNull();
    cleanup();
    // Without the computer's name (a member): just the brain and its model.
    const member = seedState();
    const codex = member.agents.find((a) => a.id === ADA_ID);
    if (codex) codex.brain = { kind: "codex", model: "GPT-6 Sol" };
    await open(member, `dm/agent/${ADA_ID}`);
    await settle(4);
    expect(document.body.textContent).toContain("Dev · de João · Codex · GPT-6 Sol");
  });

  test("sidebar agent → DM via POST /dms: header with role, owner and model; empty state; the agent answers without a mention", async () => {
    const state = seedState();
    await open(state, `dm/agent/${ADA_ID}`);
    await settle(4);
    expect(state.calls.find((c) => c.method === "dms.open")?.args).toEqual([ORG_ID, { agentId: ADA_ID }]);
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(document.body.textContent).toContain("Dev · de João · Claude Sonnet 5.5");
    // "Ver perfil": the agent's page in the panel beside the conversation (like a thread's), closed by its ×.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Ver perfil" })));
    await settle(4);
    const side = screen().getByRole("complementary", { name: "Perfil da Ada" });
    await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Fechar" })));
    expect(screen().queryByRole("complementary", { name: "Perfil da Ada" })).toBeNull();
    expect(document.querySelector(".ac-empty__text")?.textContent).toBe(
      "Peça para lembrar, esquecer ou trabalhar de outro jeito.",
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
    expect(bar().textContent).toBe("Ada está trabalhando…");
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

describe("caught up once the server confirms the channel's subscription", () => {
  test("a message written before then is added; one heard live while that read was on its way stays", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // Each read is made when asked; its answer can be held back, as on a slow link.
    let held: Promise<void> | null = null;
    const read = api.chat.messages;
    api.chat.messages = async (orgId, channelId, options) => {
      const list = await read(orgId, channelId, options);
      if (held) await held;
      return list;
    };
    const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    // Atlas wrote while the socket opened: no event carries it.
    state.messages.push({
      id: "m-before",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "Deploy das 9h revertido.",
      mentionedAgentIds: [],
      agentRunId: "r-before",
      createdAt: new Date().toISOString(),
    });
    expect(rowsWith("Deploy das 9h revertido.")).toHaveLength(0);
    let release = () => {};
    held = new Promise<void>((r) => {
      release = r;
    });
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(2);
    // Ada answers live while that read, made before her answer, is on its way.
    await push(socket, {
      type: "message.created",
      messageId: "m-live",
      message: {
        id: "m-live",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "Login de volta ao normal.",
        mentionedAgentIds: [],
        agentRunId: "r-live",
        createdAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    await settle();
    expect(rowsWith("Login de volta ao normal.")).toHaveLength(1);
    await act(async () => release());
    await settle(4);
    expect(rowsWith("Deploy das 9h revertido.")).toHaveLength(1);
    expect(rowsWith("Login de volta ao normal.")).toHaveLength(1);
  });

  test("an open thread's replies too", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.threads.create(ORG_ID, {
      id: "m-1",
      channelId: ENG_ID,
      firstMessageId: "m-1",
      lastMessageId: "m-1",
      title: "Login com 401",
    } as Parameters<typeof api.threads.create>[1]);
    const { sockets } = await renderApp(`/org/${ORG_ID}/threads/m-1`, { api });
    await settle(8);
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    state.messages.push({
      id: "m-reply",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "agent", id: ADA_ID },
      body: "Corrigido: o refresh usa segundos agora.",
      mentionedAgentIds: [],
      agentRunId: "r-reply",
      createdAt: new Date().toISOString(),
    });
    expect(rowsWith("Corrigido: o refresh usa segundos agora.")).toHaveLength(0);
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(4);
    expect(rowsWith("Corrigido: o refresh usa segundos agora.")).toHaveLength(1);
  });

  /** João's message to Ada, read while her run was at `status`. */
  const askedAda = (state: ReturnType<typeof seedState>, status: "running" | "waiting_input") => {
    const m1 = state.messages.find((m) => m.id === "m-1");
    if (m1)
      m1.receipts = {
        seenBy: [ADA_ID],
        pickedBy: [ADA_ID],
        handled: [{ agentId: ADA_ID, runId: "r-ada", status }],
        blocked: [],
      };
  };
  const question = {
    id: "q1",
    agentId: ADA_ID,
    runId: "r-ada",
    channelId: ENG_ID,
    threadId: null,
    messageId: "msg-q",
    text: "Reverto o deploy das 9h?",
    choices: ["Sim", "Não"],
    status: "open",
    answer: null,
    answeredByUserId: null,
  };
  const questionCard = {
    id: "msg-q",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent" as const, id: ADA_ID },
    body: "",
    mentionedAgentIds: [],
    agentRunId: "r-ada",
    meta: { question },
    createdAt: new Date().toISOString(),
  };
  const receiptOfM1 = () =>
    rowsWith("o login está devolvendo 401")[0]?.querySelector(".ac-receipt__check")?.getAttribute("aria-label");
  const event = (e: Record<string, unknown>) => ({
    type: "event",
    channelId: ENG_ID,
    event: { channelId: ENG_ID, ...e },
  });

  test("her question after then: the receipt waits for the answer, and the page seeding its list again keeps that", async () => {
    const state = seedState();
    askedAda(state, "running");
    const { socket } = await open(state);
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(4);
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está respondendo");
    // Her card, her question and her run's wait arrive together, before the page draws the card.
    await act(async () => {
      socket.push(event({ type: "message.created", messageId: "msg-q", message: questionCard }));
      socket.push(event({ type: "question.asked", threadId: null, question }));
      socket.push(
        event({ type: "agent.run", threadId: null, runId: "r-ada", agentId: ADA_ID, status: "waiting_input" }),
      );
    });
    await settle(4);
    expect(screen().getByRole("group", { name: "Pergunta de Ada" })).toBeTruthy();
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está esperando sua resposta");
  });

  test("her question before then: its card and the wait for the answer show, and stay as the list changes", async () => {
    const state = seedState();
    askedAda(state, "running");
    const { socket } = await open(state);
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está respondendo");
    // She asks while the channel's subscription opens: no event carries it.
    state.messages.push(questionCard);
    askedAda(state, "waiting_input");
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(4);
    expect(screen().getByRole("group", { name: "Pergunta de Ada" })).toBeTruthy();
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está esperando sua resposta");
    await push(socket, {
      type: "message.created",
      messageId: "m-atlas",
      message: {
        id: "m-atlas",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ATLAS_ID },
        body: "Deploy das 9h no ar.",
        mentionedAgentIds: [],
        agentRunId: "r-atlas",
        createdAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    await settle(4);
    expect(rowsWith("Deploy das 9h no ar.")).toHaveLength(1);
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está esperando sua resposta");
  });
});
