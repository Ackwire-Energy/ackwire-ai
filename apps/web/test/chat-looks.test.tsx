import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import type { ChatPrefs } from "@agenteschat/client/lib/chat-look";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  NOW,
  ORG_ID,
  seedDm,
  seedState,
  withChatPrefs,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const said = (channelId: string, id: string, who: string, body: string, minutes: number) =>
  ({
    id,
    channelId,
    threadId: null,
    author: who.startsWith("u-") ? { type: "person", id: who } : { type: "agent", id: who },
    body,
    mentionedAgentIds: [],
    agentRunId: who.startsWith("u-") ? null : `r-${id}`,
    createdAt: ago(minutes),
  }) as Message;

const row = (id: string) => {
  const el = document.querySelector<HTMLElement>(`article[data-message-id="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
};

async function openChannel(prefs?: ChatPrefs) {
  const messages = [
    said(ENG_ID, "j1", "u-joao", "Bom dia!", 30),
    said(ENG_ID, "w1", "u-walter", "Vi o alerta", 20),
    said(ENG_ID, "a1", ADA_ID, "Olhando.", 10),
  ];
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(withChatPrefs(seedState({ messages }), prefs)) });
  await settle(10);
}

async function openDm(prefs?: ChatPrefs) {
  const state = seedState();
  const channelId = seedDm(state, { type: "agent", id: ADA_ID }, { body: "x" });
  state.messages = [
    ...state.messages.filter((m) => m.channelId !== channelId),
    said(channelId, "w1", "u-walter", "Quantas faltam?", 20),
    said(channelId, "a1", ADA_ID, "Faltam 14.", 10),
  ];
  await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(withChatPrefs(state, prefs)) });
  await settle(10);
}

describe("the defaults", () => {
  test("a channel lists everyone on the left: my row has its face, name and time", async () => {
    await openChannel();
    const mine = row("w1");
    expect(mine.dataset.look).toBe("left");
    expect(mine.classList.contains("ac-msg--own")).toBe(false);
    expect(mine.querySelector(".ac-msg__avatar")).not.toBeNull();
    expect(mine.querySelector(".ac-msg__head .ac-msg__author")?.textContent).toContain("Walter");
    expect(mine.querySelector(".ac-msg__own-foot")).toBeNull();
  });

  test("a DM is in bubbles with the light tone: mine on the right in the agent's color, no name, the time inside", async () => {
    await openDm();
    const mine = row("w1");
    expect(mine.dataset.look).toBe("bubbles");
    expect(mine.dataset.tone).toBe("light");
    expect(mine.classList.contains("ac-msg--own")).toBe(true);
    expect(mine.style.getPropertyValue("--msg-mine")).not.toBe("");
    expect(mine.querySelector(".ac-msg__own-foot")).toBeNull();
    expect(mine.querySelector(".ac-msg__text .ac-msg__stamp")?.textContent).toContain(":");
    const theirs = row("a1");
    expect(theirs.dataset.names).toBe("false");
    expect(theirs.querySelector(".ac-msg__head")).toBeNull();
    expect(theirs.querySelector(".ac-msg__text .ac-msg__stamp")).not.toBeNull();
  });
});

describe("each style in a channel and in a DM", () => {
  test("Confortável is the original layout in both", async () => {
    await openChannel({ channelStyle: "comfortable" });
    expect(row("w1").classList.contains("ac-msg--own")).toBe(true);
    expect(row("w1").querySelector(".ac-msg__own-foot")).not.toBeNull();
    expect(row("a1").querySelector(".ac-msg__stamp")).toBeNull();
    cleanup();
    await openDm({ dmStyle: "comfortable" });
    expect(row("w1").querySelector(".ac-msg__own-foot")).not.toBeNull();
    expect(row("a1").querySelector(".ac-msg__head")).not.toBeNull();
  });

  test("Tudo à esquerda in a DM has no bubble either", async () => {
    await openDm({ dmStyle: "left" });
    expect(row("w1").classList.contains("ac-msg--own")).toBe(false);
    expect(row("w1").querySelector(".ac-msg__stamp")).toBeNull();
  });

  test("Bolhas in a channel: the name in the bubble with its color, mine in the strong tone when chosen", async () => {
    await openChannel({ channelStyle: "bubbles", channelTone: "strong" });
    const ada = row("a1");
    expect(ada.querySelector(".ac-msg__text .ac-msg__bubble-head")?.textContent).toContain("Ada");
    expect(ada.dataset.names).toBeUndefined();
    expect(ada.style.getPropertyValue("--msg-name")).not.toBe("");
    expect(row("w1").dataset.tone).toBe("strong");
  });

  test("Compacta: the time ahead of every row, mine on the left", async () => {
    for (const open of [() => openChannel({ channelStyle: "compact" }), () => openDm({ dmStyle: "compact" })]) {
      await open();
      expect(row("w1").dataset.look).toBe("compact");
      expect(row("w1").classList.contains("ac-msg--own")).toBe(false);
      expect(row("a1").querySelector(":scope > .ac-msg__clock")?.textContent).toContain(":");
      cleanup();
    }
  });
});

describe("Sua conta › Conversa", () => {
  const openSettings = async (state: FakeState) => {
    await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(state) });
    await settle(8);
  };
  const click = async (el: Element) => {
    await act(async () => fireEvent.click(el));
    await settle(4);
  };

  test("channels and DMs each save their own style; Clara and Forte show only with Bolhas", async () => {
    const state = withChatPrefs(seedState());
    await openSettings(state);
    const styles = () => screen().getByRole("radiogroup", { name: "Densidade da conversa" });
    expect(within(styles()).getByRole("radio", { name: "Tudo à esquerda" }).getAttribute("aria-checked")).toBe("true");
    expect(screen().queryByRole("radiogroup", { name: "Minhas mensagens nos canais" })).toBeNull();

    await click(within(styles()).getByRole("radio", { name: "Compacta" }));
    expect(state.calls).toContainEqual({ method: "orgs.setChatPrefs", args: [ORG_ID, { channelStyle: "compact" }] });

    await click(screen().getByRole("radio", { name: "DMs" }));
    expect(within(styles()).getByRole("radio", { name: "Bolhas" }).getAttribute("aria-checked")).toBe("true");
    const tones = screen().getByRole("radiogroup", { name: "Minhas mensagens nas DMs" });
    await click(within(tones).getByRole("radio", { name: "Forte" }));
    expect(state.calls).toContainEqual({ method: "orgs.setChatPrefs", args: [ORG_ID, { dmTone: "strong" }] });
    expect(state.me?.organizations[0]?.chatPrefs).toEqual({ channelStyle: "compact", dmTone: "strong" });
  });

  test("where a conversation opens: the newest message until the person picks", async () => {
    const state = withChatPrefs(seedState());
    await openSettings(state);
    const open = screen().getByRole("radiogroup", { name: "Ao abrir uma conversa, me leve para" });
    expect(within(open).getByRole("radio", { name: "Mensagem mais recente" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await click(within(open).getByRole("radio", { name: "Última mensagem lida" }));
    expect(state.calls).toContainEqual({ method: "orgs.setChatPrefs", args: [ORG_ID, { openAt: "read" }] });
  });

  test("a server from before the choice shows no card", async () => {
    await openSettings(seedState());
    expect(screen().queryByRole("radiogroup", { name: "Densidade da conversa" })).toBeNull();
  });
});

describe("opening at the last read message", () => {
  const openUnread = async (prefs: ChatPrefs) => {
    const messages = [
      said(ENG_ID, "a0", ADA_ID, "Lida.", 60),
      said(ENG_ID, "a1", ADA_ID, "Nova um.", 10),
      said(ENG_ID, "a2", ADA_ID, "Nova dois.", 5),
    ];
    const state = withChatPrefs(seedState({ messages }), prefs);
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) Object.assign(eng, { unreadCount: 2, lastReadAt: ago(30) });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(10);
  };

  test("the Novas line goes before the first unread message", async () => {
    await openUnread({ openAt: "read" });
    const line = document.querySelector(".channel__unread");
    expect(line).not.toBeNull();
    expect(line?.nextElementSibling).toBe(row("a1"));
  });

  test("by default it opens at the end, with no line", async () => {
    await openUnread({});
    expect(document.querySelector(".channel__unread")).toBeNull();
  });
});
