import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * Agents' live rows on screen or not, as the test says: happy-dom lays nothing out and its observer never answers, so
 * every row would count as out of view. `scroll(false)` takes them out of view, `scroll(true)` brings them back.
 */
function rowsOnScreen() {
  const native = globalThis.IntersectionObserver;
  let shown = true;
  const watched: { observer: object; answer: IntersectionObserverCallback; target: Element }[] = [];
  const entry = (target: Element) => ({ isIntersecting: shown, target }) as IntersectionObserverEntry;
  globalThis.IntersectionObserver = class {
    answer: IntersectionObserverCallback;
    constructor(answer: IntersectionObserverCallback) {
      this.answer = answer;
    }
    observe(target: Element) {
      if (!target.matches("[data-run-id]")) return;
      watched.push({ observer: this, answer: this.answer, target });
      this.answer([entry(target)], this as never);
    }
    unobserve() {}
    disconnect() {
      for (let i = watched.length - 1; i >= 0; i--) if (watched[i]?.observer === this) watched.splice(i, 1);
    }
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  return {
    scroll: (on: boolean) =>
      act(async () => {
        shown = on;
        for (const w of [...watched]) w.answer([entry(w.target)], w.observer as never);
      }),
    undo: () => {
      globalThis.IntersectionObserver = native;
    },
  };
}

let view: ReturnType<typeof rowsOnScreen> | null = null;
afterEach(() => {
  cleanup();
  view?.undo();
  view = null;
});

const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };

const open = async () => {
  const rows = rowsOnScreen();
  view = rows;
  const state = seedState();
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
  return { state, ev, scroll: rows.scroll };
};
/** At work for a while already, on a step: its row shows at once. */
const working = async (ev: (event: Record<string, unknown>) => Promise<void>) => {
  await ev({ type: "agent.run", ...ids, status: "running", startedAt: new Date(Date.now() - 13_000).toISOString() });
  await ev({ type: "agent.tool", ...ids, tool: "read_file", toolUseId: "t1", detail: "apps/api/auth/refresh.ts" });
  await settle(3);
};
const bar = () => document.querySelector(".ac-typing") as HTMLElement;
const row = () => document.querySelector('[data-run-id="r-live"]') as HTMLElement;
const typing = (ev: (event: Record<string, unknown>) => Promise<void>) =>
  ev({ type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
const cancels = (state: ReturnType<typeof seedState>) => state.calls.filter((c) => c.method === "agents.cancelRun");

describe("the live row says it, the bar only for what is out of view", () => {
  test("its row on screen: the bar says nothing of it; the row's step ends in its time and its stop", async () => {
    const { state, ev } = await open();
    await working(ev);
    expect(row().classList.contains("ac-msg--waiting")).toBe(true);
    expect(bar().dataset.active).toBe("false");
    expect(bar().textContent).toBe("");
    const step = row().querySelector(".ac-wait__step") as HTMLElement;
    expect(step.getAttribute("title")).toBe("Mexendo nos arquivos do PC · refresh.ts…");
    const tail = step.nextElementSibling as HTMLElement;
    expect(tail.classList.contains("run-tail")).toBe(true);
    expect(tail.querySelector(".run-tail__clock")?.textContent).toMatch(/^1\d s$/);
    await act(async () => fireEvent.click(within(tail).getByRole("button", { name: "Parar" })));
    await settle(2);
    expect(cancels(state)).toHaveLength(1);
  });

  test("its row drawn a moment after it starts: the bar speaks meanwhile, then goes quiet once the row is on screen", async () => {
    const { ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    expect(row()).toBeNull();
    expect(bar().dataset.active).toBe("true");
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada pensando…");
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    await settle(2);
    expect(row()).not.toBeNull();
    expect(bar().dataset.active).toBe("false");
  });

  test("its row out of view: the bar comes back with its face, the row's step, its time, 'Ver' and its stop", async () => {
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
    const before = proto.scrollIntoView;
    const scrolled: string[] = [];
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute("data-run-id") ?? "");
    };
    try {
      const { state, ev, scroll } = await open();
      await working(ev);
      await scroll(false);
      await settle(2);
      expect(bar().dataset.active).toBe("true");
      expect(bar().querySelector(".ac-typing__avatars .ac-avatar--agent")).not.toBeNull();
      // The row's own words, after the name, with a lower-case start; the whole step as its tip.
      expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada mexendo nos arquivos do PC · refresh.ts…");
      expect(bar().querySelector(".ac-typing__step")?.getAttribute("title")).toBe(
        "mexendo nos arquivos do PC · refresh.ts…",
      );
      expect(bar().querySelector(".ac-typing__elapsed")?.textContent).toMatch(/^1\d s$/);
      expect(bar().dataset.wide).toBeUndefined();
      await act(async () => fireEvent.click(within(bar()).getByRole("button", { name: "Ver" })));
      expect(scrolled).toContain("r-live");
      // Back in view: quiet again.
      await scroll(true);
      await settle(2);
      expect(bar().dataset.active).toBe("false");
      await scroll(false);
      await settle(2);
      await act(async () => fireEvent.click(within(bar()).getByRole("button", { name: "Parar" })));
      await settle(2);
      expect(cancels(state)).toHaveLength(1);
    } finally {
      proto.scrollIntoView = before;
    }
  });

  test("someone typing while its row is on screen: only them, never the agent again", async () => {
    const { ev } = await open();
    await working(ev);
    await typing(ev);
    await settle();
    expect(bar().dataset.active).toBe("true");
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("João está digitando…");
    expect(bar().querySelector(".ac-typing__dots")).not.toBeNull();
    expect(bar().querySelectorAll(".ac-typing__tok .ac-avatar")).toHaveLength(1);
    expect(bar().querySelector(".ac-avatar--agent")).toBeNull();
    expect(bar().textContent).not.toContain("Ada");
    expect(bar().querySelector(".ac-typing__elapsed, .stop-run")).toBeNull();
    expect(within(bar()).queryByRole("button", { name: "Ver" })).toBeNull();
  });

  test("someone typing and its row out of view: 'Ada mexendo… · 13 s · João digitando…', the time and stop hers", async () => {
    const { ev, scroll } = await open();
    await working(ev);
    await typing(ev);
    await scroll(false);
    await settle(2);
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada mexendo nos arquivos do PC · refresh.ts…");
    const took = bar().querySelector(".ac-typing__elapsed") as HTMLElement;
    expect(took.textContent).toMatch(/^1\d s$/);
    const also = took.nextElementSibling as HTMLElement;
    expect(also.classList.contains("ac-typing__also")).toBe(true);
    expect(also.textContent).toBe("João digitando…");
    expect(also.querySelector(".ac-typing__typers")?.textContent).toBe("João");
    // Both faces; the pill widens for both; "Ver" and the stop at its end.
    expect(bar().querySelectorAll(".ac-typing__tok")).toHaveLength(2);
    expect(bar().dataset.wide).toBe("true");
    expect(within(bar()).getByRole("button", { name: "Ver" })).toBeTruthy();
    expect(bar().lastElementChild?.querySelector(".stop-run")).not.toBeNull();
  });
});

test("the composer's own stop stays while the bar is quiet", async () => {
  const { ev } = await open();
  await working(ev);
  expect(bar().dataset.active).toBe("false");
  expect(screen().getByRole("button", { name: "Parar a Ada" })).toBeTruthy();
});
