import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { COMPUTER_KINDS, COMPUTER_STATES, ComputerIcon, ComputerPortrait, drawComputer } from "../src";
import { liveComputerCount } from "../src/computer/live";

/** Records the cells drawn, by color. */
function fakeCtx() {
  const cells = new Map<string, string>();
  const ctx = {
    fillStyle: "" as unknown,
    fillRect(x: number, y: number) {
      cells.set(`${x},${y}`, String(ctx.fillStyle));
    },
    clearRect(x: number, y: number, w: number, h: number) {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) cells.delete(`${i},${j}`);
    },
  };
  return { ctx, cells };
}

describe("computer portraits (IconesComputador.html)", () => {
  test("every kind and state draws inside the 48×48 grid", () => {
    for (const kind of COMPUTER_KINDS)
      for (const state of COMPUTER_STATES) {
        const { ctx, cells } = fakeCtx();
        drawComputer(ctx, kind, state, { t: 1.2 });
        expect(cells.size).toBeGreaterThan(200);
        for (const key of cells.keys()) {
          const [x, y] = key.split(",").map(Number);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThan(48);
        }
      }
  });

  test("the screen shows the sky when on and goes dark when offline", () => {
    const sky = (state: "online" | "offline") => {
      const { ctx, cells } = fakeCtx();
      drawComputer(ctx, "mac", state);
      return [...cells.values()].some((c) => c === "#0063d1" || c === "#2f80e0");
    };
    expect(sky("online")).toBe(true);
    expect(sky("offline")).toBe(false);
  });

  test("the portrait is a 48-cell canvas scaled by whole numbers; decorative unless labeled", () => {
    const { container, unmount } = render(
      <div>
        <ComputerPortrait kind="mac" state="online" />
        <ComputerPortrait kind="cloud" state="paused" size={96} label="Computador na nuvem" />
        <ComputerIcon kind="windows" />
      </div>,
    );
    const [small, big] = [...container.querySelectorAll("canvas.ac-computer")] as HTMLCanvasElement[];
    expect(small?.width).toBe(48);
    expect(small?.style.width).toBe("48px");
    expect(small?.getAttribute("aria-hidden")).toBe("true");
    expect(small?.dataset.kind).toBe("mac");
    expect(big?.style.width).toBe("96px");
    expect(big?.dataset.state).toBe("paused");
    expect(big?.getAttribute("aria-label")).toBe("Computador na nuvem");
    expect(container.querySelector("svg.ac-icon")).not.toBeNull();
    expect(liveComputerCount()).toBe(2);
    unmount();
    expect(liveComputerCount()).toBe(0);
  });
});
