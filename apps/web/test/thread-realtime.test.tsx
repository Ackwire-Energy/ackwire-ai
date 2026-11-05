import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ActiveRun, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

type Surface = "panel" | "page";

const reply = (id: string, body: string, over: Partial<Message> = {}): Message => ({
  id,
  channelId: ENG_ID,
  threadId: "m-1",
  author: { type: "person", id: "u-joao" },
  body,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: new Date().toISOString(),
  ...over,
});

const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

async function openChannel(state: ReturnType<typeof seedState>, api = createFakeApi(state)) {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
  await settle(3);
  return { ...r, socket };
}

async function openPanel(rootId = "m-1") {
  await act(async () => fireEvent.mouseEnter(row(rootId)));
  await act(async () =>
    fireEvent.click(within(within(row(rootId)).getByRole("toolbar")).getByRole("button", { name: "Responder" })),
  );
  await settle(8);
  return screen().getByRole("complementary", { name: "Thread" });
}

async function open(surface: Surface, state: ReturnType<typeof seedState>) {
  if (surface === "panel") {
    const r = await openChannel(state);
    return { ...r, view: await openPanel() };
  }
  const r = await renderApp(`/org/${ORG_ID}/threads/m-1`, { api: createFakeApi(state) });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
  await settle(3);
  return { ...r, socket, view: document.body };
}

type Pushes = { push: (frame: unknown) => void };
const event = (socket: Pushes, e: Record<string, unknown>) =>
  act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...e } }));
const created = (socket: Pushes, m: Message) => event(socket, { type: "message.created", messageId: m.id, message: m });
const inView = (view: HTMLElement, text: string) =>
  [...view.querySelectorAll("article")].filter((a) => a.textContent?.includes(text));

describe.each(["panel", "page"] as const)("%s", (surface) => {
  test("a person's reply", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "resposta da pessoa");
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(view, "resposta da pessoa")).toHaveLength(1);
  });

  test("a reply from my other device", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "do meu celular", {
      author: { type: "person", id: state.me?.user.id ?? null },
      clientId: "other-device",
    });
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(view, "do meu celular")).toHaveLength(1);
  });

  test("an agent's reply", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "resposta da Ada", { author: { type: "agent", id: ADA_ID }, agentRunId: "run-a" });
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(view, "resposta da Ada")).toHaveLength(1);
  });

  test("a live run: thinking, its tool once, its output once, its words, then its saved message in one row", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const run = { runId: "run-a", agentId: ADA_ID, threadId: "m-1" };
    await event(socket, { type: "agent.thinking", ...run });
    await settle(2);
    expect(view.textContent).toContain("Ada");
    await event(socket, {
      type: "agent.tool",
      ...run,
      tool: "run_code",
      toolUseId: "t1",
      code: { language: "bash", source: "echo oi" },
    });
    await event(socket, { type: "agent.tool.output", ...run, toolUseId: "t1", stream: "stdout", text: "saida\n" });
    await settle(2);
    await act(async () => fireEvent.click(within(view).getByRole("button", { name: "Ver código da Ada" })));
    const live = view.querySelector(".live-code") as HTMLElement;
    expect(within(live).getByLabelText("Saída").querySelector(".live-code__stdout")?.textContent).toBe("saida\n");
    await event(socket, { type: "agent.tool", ...run, tool: null, toolUseId: "t1" });
    await event(socket, { type: "agent.delta", ...run, seq: 0, turn: 1, at: 0, text: "escrevendo a resposta" });
    await settle(2);
    expect(view.textContent).toContain("escrevendo a resposta");
    const m = reply("r-1", "escrevendo a resposta final", {
      author: { type: "agent", id: ADA_ID },
      agentRunId: "run-a",
    });
    state.messages.push(m);
    await created(socket, m);
    await event(socket, { type: "run.finished", ...run, status: "done" });
    await settle(3);
    expect(inView(view, "escrevendo a resposta final")).toHaveLength(1);
  });

  test("a message too big for its event", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "resposta grande", { author: { type: "agent", id: ADA_ID }, agentRunId: "run-a" });
    state.messages.push(m);
    await event(socket, { type: "message.created", messageId: m.id, threadId: "m-1", agentRunId: "run-a" });
    await settle(5);
    expect(inView(view, "resposta grande")).toHaveLength(1);
  });

  test("a reaction on a reply", async () => {
    const state = seedState();
    const m = reply("r-1", "para reagir");
    state.messages.push(m);
    const { socket } = await open(surface, state);
    await event(socket, {
      type: "message.reactions",
      messageId: "r-1",
      reactions: [{ reaction: "🚀", count: 1, userIds: ["u-joao"] }],
    });
    await settle(3);
    const pills = within(row("r-1")).getByRole("group", { name: "Reações" });
    expect(within(pills).getByRole("button", { name: "João reagiu com 🚀" })).toBeTruthy();
  });

  test("a reconnect: what came meanwhile shows", async () => {
    const state = seedState();
    const { socket, sockets, view } = await open(surface, state);
    await act(async () => socket.drop());
    state.messages.push(reply("r-1", "enquanto caiu"));
    await act(() => new Promise((r) => setTimeout(r, 650)));
    const next = sockets.last();
    await act(async () => next.open());
    await act(async () => next.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(5);
    expect(inView(view, "enquanto caiu")).toHaveLength(1);
  });

  test("a reconnect: the header counts what came meanwhile", async () => {
    const state = seedState();
    const { socket, sockets, view } = await open(surface, state);
    await act(async () => socket.drop());
    state.messages.push(reply("r-1", "enquanto caiu"));
    await act(() => new Promise((r) => setTimeout(r, 650)));
    const next = sockets.last();
    await act(async () => next.open());
    await act(async () => next.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(5);
    expect(view.querySelector(".thread-head__meta")?.textContent).toContain("1 resposta");
  });

  test("a tab hidden a while: what came meanwhile shows", async () => {
    const state = seedState();
    const { view } = await open(surface, state);
    const visibility = (value: "hidden" | "visible") =>
      act(async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    try {
      await visibility("hidden");
      state.messages.push(reply("r-1", "enquanto escondida"));
      setSystemTime(new Date(Date.now() + 60_000));
      await visibility("visible");
      await settle(5);
      expect(inView(view, "enquanto escondida")).toHaveLength(1);
    } finally {
      setSystemTime();
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  test("the header's count follows the replies", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "a primeira");
    state.messages.push(m);
    await created(socket, m);
    await settle(5);
    expect(view.querySelector(".thread-head__meta")?.textContent).toContain("1 resposta");
  });

  test("a receipt on a reply follows the router", async () => {
    const state = seedState();
    const m = reply("r-1", "minha resposta", { author: { type: "person", id: state.me?.user.id ?? null } });
    state.messages.push(m);
    const { socket } = await open(surface, state);
    await event(socket, { type: "message.routed", messageId: "r-1", seenBy: [ADA_ID], pickedBy: [] });
    await settle(3);
    expect(row("r-1").querySelector(".ac-receipt__check")).toBeTruthy();
  });
});

test("a run already live when the panel opens: its words show there", async () => {
  const state = seedState();
  const api = createFakeApi(state);
  const run = { runId: "run-a", agentId: ADA_ID, threadId: "m-1" };
  api.agents.activeRuns = async () => [{ ...run, channelId: ENG_ID, status: "running" } as ActiveRun];
  const { socket } = await openChannel(state, api);
  await event(socket, { type: "agent.thinking", ...run });
  await event(socket, { type: "agent.delta", ...run, seq: 0, turn: 1, at: 0, text: "ja escrevendo" });
  await settle(2);
  const side = await openPanel();
  expect(side.textContent).toContain("ja escrevendo");
});

describe("a thread opened after the live events began its list", () => {
  const withEarlier = () => {
    const state = seedState();
    state.messages.push(reply("r-old-1", "resposta antiga um"), reply("r-old-2", "resposta antiga dois"));
    return state;
  };

  test("a reply heard before opening: the earlier ones show too", async () => {
    const state = withEarlier();
    const { socket } = await openChannel(state);
    const m = reply("r-new", "resposta nova");
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    const side = await openPanel();
    await settle(5);
    expect(inView(side, "resposta nova")).toHaveLength(1);
    expect(inView(side, "resposta antiga um")).toHaveLength(1);
    expect(inView(side, "resposta antiga dois")).toHaveLength(1);
  });

  test("replies said while away from the channel: the hole before the one heard live fills", async () => {
    const state = seedState();
    const { socket, router } = await openChannel(state);
    const go = (channelId: string) =>
      act(() => router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId } }));
    const side = await openPanel();
    expect(side).toBeTruthy();
    await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Fechar a thread" })));
    await settle(3);
    await go(GENERAL_ID);
    await settle(4);
    state.messages.push(reply("r-away", "enquanto fora do canal"));
    await go(ENG_ID);
    await settle(4);
    const m = reply("r-new", "resposta nova");
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    const again = await openPanel();
    await settle(5);
    expect(inView(again, "resposta nova")).toHaveLength(1);
    expect(inView(again, "enquanto fora do canal")).toHaveLength(1);
  });
});

describe("other conversations shown as a thread", () => {
  test("a thread whose root the channel's list doesn't hold: live replies land", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const read = api.chat.messages;
    api.chat.messages = async (o, c, opts) => (await read(o, c, opts)).filter((m) => opts?.threadId || m.id !== "m-1");
    const old = reply("r-old", "fixada na thread", { author: { type: "agent", id: ADA_ID } });
    state.messages.push(old);
    api.pins = {
      list: async () => [
        {
          messageId: old.id,
          channelId: ENG_ID,
          threadId: "m-1",
          pinnedByUserId: "u-joao",
          pinnedAt: old.createdAt,
          message: old,
        },
      ],
      pin: async () => ({}) as never,
      unpin: async () => {},
    };
    const { socket } = await openChannel(state, api);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Mensagens fixadas \(/ })));
    await settle(2);
    const list = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
    await act(async () => fireEvent.click(list.querySelector(".thread-pop__row") as HTMLElement));
    await settle(8);
    const side = screen().getByRole("complementary", { name: "Thread" });
    const m = reply("r-1", "ao vivo");
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(side, "ao vivo")).toHaveLength(1);
    expect(inView(side, "fixada na thread")).toHaveLength(1);
  });

  test("a DM's thread: a live reply lands", async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ADA_ID });
    const channelId = `dm-${ADA_ID}`;
    const rootId = `m-${channelId}`;
    const r = await renderApp(`/org/${ORG_ID}/threads/${rootId}`, { api: createFakeApi(state) });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () => socket.push({ type: "subscribed", channelId }));
    await settle(3);
    const m = reply("r-1", "no dm", { channelId, threadId: rootId, author: { type: "agent", id: ADA_ID } });
    state.messages.push(m);
    await act(async () =>
      socket.push({
        type: "event",
        channelId,
        event: { channelId, type: "message.created", messageId: m.id, message: m },
      }),
    );
    await settle(3);
    expect(inView(document.body, "no dm")).toHaveLength(1);
  });

  test("a task's conversation: a live reply lands, its header counts it", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const at = await api.issues.conversation(ORG_ID, (await api.issues.get(ORG_ID, 131)).id);
    let said = 0;
    const list = api.issues.list;
    api.issues.list = async (o, f) =>
      (await list(o, f)).map((i) => (i.conversation ? { ...i, conversation: { ...i.conversation, count: said } } : i));
    const r = await renderApp(`/org/${ORG_ID}/issues?open=131`, { api });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Conversa" })));
    await settle(8);
    await act(async () => socket.push({ type: "subscribed", channelId: at.channelId }));
    await settle(3);
    const m = reply("r-1", "na tarefa", {
      channelId: at.channelId,
      threadId: at.rootId,
      author: { type: "agent", id: ADA_ID },
    });
    state.messages.push(m);
    said = 1;
    await act(async () =>
      socket.push({
        type: "event",
        channelId: at.channelId,
        event: { channelId: at.channelId, type: "message.created", messageId: m.id, message: m },
      }),
    );
    await settle(5);
    expect(inView(dialog, "na tarefa")).toHaveLength(1);
    expect(dialog.querySelector(".thread-head__meta")?.textContent).toContain("1 mensagem");
    expect(within(dialog).getByRole("button", { name: /^Conversa.*1/ })).toBeTruthy();
  });

  test("a mission's thread: a live reply lands", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.missions.create(ORG_ID, { agentId: ADA_ID, goal: "Construir o app", channelId: ENG_ID, threadId: "m-1" });
    const r = await renderApp(`/org/${ORG_ID}/threads/m-1`, { api });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(3);
    const m = reply("r-1", "na missao", { author: { type: "agent", id: ADA_ID } });
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(document.body, "na missao")).toHaveLength(1);
  });
});
