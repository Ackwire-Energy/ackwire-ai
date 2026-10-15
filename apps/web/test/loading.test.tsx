import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { Message } from "@/api/types";
import { stepAt } from "@/components/Loading";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("loading states", () => {
  test("a conversation: message-shaped skeleton while it loads, then the messages (composer stays put)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const held = deferred<Message[]>();
    const real = api.chat.messages;
    let first = true;
    api.chat.messages = (orgId, channelId, options) => {
      if (first && !options?.threadId) {
        first = false;
        return held.promise;
      }
      return real(orgId, channelId, options);
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const skeleton = screen().getByRole("status", { name: "Carregando mensagens" });
    expect(skeleton.querySelectorAll(".ac-skeleton-msg").length).toBeGreaterThan(2);
    // The composer is already there: nothing jumps when the messages arrive.
    const composer = screen().getByRole("combobox", { name: /Mensagem para|#eng/ });
    await wait(200);
    expect(skeleton.hasAttribute("data-visible")).toBe(true);
    await act(async () => held.resolve(await real(ORG_ID, ENG_ID)));
    await settle(6);
    expect(screen().queryByRole("status", { name: "Carregando mensagens" })).toBeNull();
    expect(screen().getByRole("combobox", { name: /Mensagem para|#eng/ })).toBe(composer);
  });

  test("an error: a friendly line and Tentar de novo", async () => {
    const api = createFakeApi(seedState());
    let calls = 0;
    const real = api.issues.list;
    api.issues.list = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return real(...args);
    };
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(10);
    const retry = screen().queryByRole("button", { name: "Tentar de novo" });
    if (retry) {
      await act(async () => fireEvent.click(retry));
      await settle(6);
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen().queryByRole("status", { name: "Carregando a lista" })).toBeNull();
  });

  test("long actions: the step follows the clock (fake time)", () => {
    expect(stepAt(0, 0, 3)).toBe(0);
    expect(stepAt(0, 2499, 3)).toBe(0);
    expect(stepAt(0, 2500, 3)).toBe(1);
    expect(stepAt(0, 60_000, 3)).toBe(2);
  });

  test("the sidebar shows placeholder rows while channels load", async () => {
    const api = createFakeApi(seedState());
    const held = deferred<Awaited<ReturnType<typeof api.chat.channels>>>();
    const real = api.chat.channels;
    api.chat.channels = () => held.promise;
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(4);
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(within(nav).getAllByRole("status", { name: "Carregando a lista" }).length).toBeGreaterThan(0);
    await act(async () => held.resolve(await real(ORG_ID)));
    await settle(6);
    expect(within(nav).getByRole("link", { name: /eng/ })).toBeTruthy();
  });
});
