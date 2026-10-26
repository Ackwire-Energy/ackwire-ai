import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { type RailStep, StepRail } from "@/components/StepRail";

const NAMES = ["Workspace", "Contexto", "Seus agentes", "Computador", "Agentes e IA", "Time", "Pronto"];
const steps: RailStep[] = NAMES.map((name, i) => ({ id: `s${i}`, name, done: i < 6, disabled: false }));

/**
 * The step bar as a phone lays it out (the rail's CSS at 390px): a 231px strip from x = 16 and the steps' 32px
 * pills 4px apart, moved by the strip's own sideways scroll.
 */
const real = HTMLElement.prototype.getBoundingClientRect;
const box = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 32, width, height: 32 });
function phoneWidth() {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const strip = this.parentElement;
    if (this.classList.contains("onb__steps")) return box(16, 231) as DOMRect;
    if (strip?.classList.contains("onb__steps"))
      return box(16 + [...strip.children].indexOf(this) * 36 - strip.scrollLeft, 32) as DOMRect;
    return real.call(this);
  };
}

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = real;
  cleanup();
});

const rail = (current: number) => (
  <StepRail label="Passos para começar" steps={steps} current={current} onGo={() => {}} doneLabel="(concluído)" />
);

describe("the step bar on a phone", () => {
  test("it scrolls sideways to keep the current step in sight: Done, the last, shows whole", () => {
    phoneWidth();
    const { container, rerender } = render(rail(6));
    const strip = container.querySelector(".onb__steps") as HTMLElement;
    // Done's pill ends at 16 + 6 × 36 + 32 = 264, past the strip's 247: 17px more.
    expect(strip.scrollLeft).toBe(17);
    // Back to the first step: the strip scrolls back to show it.
    rerender(rail(0));
    expect(strip.scrollLeft).toBe(0);
  });

  test("the window narrowed to a phone's while on Done: the strip follows as it resizes", () => {
    const g = globalThis as unknown as { ResizeObserver: unknown };
    const saved = g.ResizeObserver;
    let resized = () => {};
    g.ResizeObserver = class {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {}
      disconnect() {}
    };
    try {
      const { container } = render(rail(6));
      const strip = container.querySelector(".onb__steps") as HTMLElement;
      expect(strip.scrollLeft).toBe(0);
      phoneWidth();
      resized();
      expect(strip.scrollLeft).toBe(17);
    } finally {
      g.ResizeObserver = saved;
    }
  });

  test("a step already in sight, or a rail that fits (the desktop's column), moves nothing", () => {
    phoneWidth();
    const { container } = render(rail(3));
    expect((container.querySelector(".onb__steps") as HTMLElement).scrollLeft).toBe(0);
    HTMLElement.prototype.getBoundingClientRect = real;
    cleanup();
    const desktop = render(rail(6));
    expect((desktop.container.querySelector(".onb__steps") as HTMLElement).scrollLeft).toBe(0);
  });
});
