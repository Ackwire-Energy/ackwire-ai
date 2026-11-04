import { afterEach, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { DESKTOP_QUERY } from "@/components/NavDrawer";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;
afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const thread = () => screen().queryByRole("complementary", { name: "Thread" });
const members = () => screen().queryByRole("complementary", { name: "Membros de #eng" });

/** A desktop, #eng open, and a thread opened from its pinned reply. */
async function openThread() {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === DESKTOP_QUERY,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const state = seedState();
  const reply: Message = {
    id: "m-reply",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "Corrigido no refresh",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
  };
  state.messages.push(reply);
  const api = createFakeApi(state);
  const pin = {
    messageId: reply.id,
    channelId: ENG_ID,
    threadId: "m-1",
    pinnedByUserId: "u-joao",
    pinnedAt: "2026-11-01T10:00:00.000Z",
    message: reply,
  };
  api.pins = { list: async () => [pin], pin: async () => ({}) as never, unpin: async () => {} };
  const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  expect(members()).toBeTruthy();
  await click(screen().getByRole("button", { name: /^Mensagens fixadas \(/ }));
  await settle(2);
  const list = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
  await click(list.querySelector(".thread-pop__row") as HTMLElement);
  await settle(6);
  return { router };
}

test("a thread opens in the members column's place, beside the channel, with no scrim; closing it brings them back", async () => {
  const { router } = await openThread();
  const side = thread() as HTMLElement;
  expect(side).toBeTruthy();
  expect(side.classList.contains("thread-panel--docked")).toBe(true);
  // In the channel's body, right of the conversation, under the channel's header.
  const body = side.parentElement as HTMLElement;
  expect(body.classList.contains("channel__body")).toBe(true);
  expect(side.previousElementSibling?.classList.contains("channel__col")).toBe(true);
  // The members give it their place; nothing dims the channel, which stays in use.
  expect(members()).toBeNull();
  expect(document.querySelector(".thread-panel__scrim")).toBeNull();
  expect(screen().getByRole("button", { name: "Membros do canal (4)" }).getAttribute("aria-pressed")).toBe("false");
  // Its own page is one click away.
  expect(within(side).getByRole("button", { name: "Abrir em tela cheia" })).toBeTruthy();

  await click(within(side).getByRole("button", { name: "Fechar a thread" }));
  await settle(3);
  expect(thread()).toBeNull();
  expect(members()).toBeTruthy();
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
});

test("the members toggle with a thread open closes the thread and shows the members", async () => {
  await openThread();
  expect(thread()).toBeTruthy();
  await click(screen().getByRole("button", { name: "Membros do canal (4)" }));
  await settle(3);
  expect(thread()).toBeNull();
  expect(members()).toBeTruthy();
});
