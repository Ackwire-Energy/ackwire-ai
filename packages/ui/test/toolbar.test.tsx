import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, render } from "@testing-library/react";
import { Toolbar } from "../src";

describe("Toolbar", () => {
  /** A ResizeObserver whose callbacks the test calls, as a window or a filter changing width would. */
  const observe = () => {
    const callbacks: (() => void)[] = [];
    const was = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    return {
      resize: () =>
        act(() => {
          for (const callback of callbacks) callback();
        }),
      callbacks,
      restore: () => (globalThis.ResizeObserver = was),
    };
  };
  const width = (el: Element, w: number) => {
    (el as HTMLElement).getBoundingClientRect = () => ({ width: w }) as DOMRect;
  };

  test("takes two rows when its parts at their widths, the search at its floor, don't fit one, and one when they do", () => {
    const ro = observe();
    try {
      const { container } = render(
        <Toolbar search={<input aria-label="Buscar arquivos" />} actions={<button type="button">Data</button>}>
          <button type="button">Canal</button>
        </Toolbar>,
      );
      const bar = container.querySelector(".ac-toolbar") as HTMLElement;
      const [search, filters, actions] = [...bar.children] as HTMLElement[];
      Object.defineProperty(bar, "clientWidth", { configurable: true, value: 400 });
      bar.style.columnGap = "8px";
      (search as HTMLElement).style.minWidth = "160px";
      width(filters as HTMLElement, 150);
      width(actions as HTMLElement, 60);
      ro.resize();
      // 160 + 150 + 60 and two gaps: 386 of 400.
      expect(bar.hasAttribute("data-stack")).toBe(false);
      width(filters as HTMLElement, 200);
      ro.resize();
      expect(bar.hasAttribute("data-stack")).toBe(true);
      width(filters as HTMLElement, 150);
      ro.resize();
      expect(bar.hasAttribute("data-stack")).toBe(false);
    } finally {
      ro.restore();
    }
  });

  test("a toolbar without a search wraps as it is: nothing measures it", () => {
    const ro = observe();
    try {
      const { container } = render(
        <Toolbar actions={<button type="button">Hoje</button>}>
          <button type="button">Rotinas</button>
        </Toolbar>,
      );
      expect(ro.callbacks).toEqual([]);
      expect(container.querySelector(".ac-toolbar")?.hasAttribute("data-stack")).toBe(false);
    } finally {
      ro.restore();
    }
  });
});
