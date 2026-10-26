import { afterEach, describe, expect, jest, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "@/i18n";
import { Computer } from "@/pages/landing/Computer";
import { LandingContext, type LandingContextValue } from "@/pages/landing/context";
import { Hero } from "@/pages/landing/Hero";
import { Onboarding } from "@/pages/landing/Onboarding";
import { Team } from "@/pages/landing/Team";

const g = globalThis as unknown as Record<string, unknown>;
const realObserver = g.IntersectionObserver;

/** Every section on screen at once, as soon as it is watched. */
class OnScreen {
  constructor(private readonly cb: (entries: { isIntersecting: boolean; target: Element }[], o: unknown) => void) {}
  observe(target: Element) {
    this.cb([{ isIntersecting: true, target }], this);
  }
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  g.IntersectionObserver = realObserver;
});

/** A landing section with motion reduced or not, its clock run by hand; `gazes` counts where the giant was told to look. */
function renderSection(node: ReactNode, reduced: boolean) {
  jest.useFakeTimers();
  g.IntersectionObserver = OnScreen;
  const gazes: [number, number][] = [];
  const ctx: LandingContextValue = {
    reduced,
    aim: { register: () => () => undefined, at: (x, y) => void gazes.push([x, y]), lock: () => undefined },
    scrollTo: () => undefined,
    theme: "light",
  };
  const view = render(
    <I18nextProvider i18n={createI18n("en")}>
      <LandingContext.Provider value={ctx}>{node}</LandingContext.Provider>
    </I18nextProvider>,
  );
  return { ...view, gazes };
}

/** Runs `ms` of the page's clock, letting each script go on between its waits. */
async function run(ms: number) {
  for (let left = ms; left > 0; left -= 100) {
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
  }
}

describe("the landing with reduced motion holds still", () => {
  test("the hero's sample conversation is how it ends, at once: nothing arrives, the giant never hops or turns", async () => {
    let hops = 0;
    const hero = () => (
      <Hero
        giantLook={0}
        giantState="idle"
        giantJoy=""
        onGiantClick={() => undefined}
        onCelebrate={() => hops++}
        waitlist={<div />}
        waitlistRef={createRef()}
      />
    );
    const still = renderSection(hero(), true);
    await run(200);
    const feed = still.container.querySelector(".lp-hero-feed");
    expect(feed?.textContent).toContain("Done, uploads are back. No errors in 2 minutes.");
    expect(feed?.textContent).toContain("Approved by you");
    expect(feed?.textContent).not.toContain("Try it");
    const at = still.container.innerHTML;
    const looked = still.gazes.length;
    await run(30_000);
    expect(still.container.innerHTML).toBe(at);
    expect(still.gazes).toHaveLength(looked);
    expect(hops).toBe(0);
    cleanup();

    // With motion, the same conversation plays and loops.
    const moving = renderSection(hero(), false);
    await run(200);
    const first = moving.container.innerHTML;
    await run(10_000);
    expect(moving.container.innerHTML).not.toBe(first);
  });

  test("the team's agents don't consult each other on their own", async () => {
    const still = renderSection(<Team />, true);
    await run(200);
    const at = still.container.innerHTML;
    await run(30_000);
    expect(still.container.innerHTML).toBe(at);
    expect(still.container.querySelector(".lp-team-say")).toBeNull();
    cleanup();

    const moving = renderSection(<Team />, false);
    await run(1500);
    expect(moving.container.querySelector(".lp-team-say")).not.toBeNull();
  });

  test("the computer's sample shows how it ends, at once, and nothing more happens", async () => {
    const still = renderSection(<Computer />, true);
    await run(200);
    expect(still.container.querySelector(".lp-computer-title")?.textContent).toBe("Nina is done");
    expect(still.container.querySelectorAll(".lp-computer-steps li")).toHaveLength(5);
    const at = still.container.innerHTML;
    await run(30_000);
    expect(still.container.innerHTML).toBe(at);
    cleanup();

    // With motion, it plays.
    const moving = renderSection(<Computer />, false);
    await run(200);
    const first = moving.container.innerHTML;
    await run(3000);
    expect(moving.container.innerHTML).not.toBe(first);
  });

  test("the onboarding stays on its step until the visitor moves it", async () => {
    const still = renderSection(<Onboarding />, true);
    await run(200);
    const at = still.container.innerHTML;
    await run(30_000);
    expect(still.container.innerHTML).toBe(at);
    cleanup();

    const moving = renderSection(<Onboarding />, false);
    await run(200);
    const first = moving.container.innerHTML;
    await run(4000);
    expect(moving.container.innerHTML).not.toBe(first);
  });
});
