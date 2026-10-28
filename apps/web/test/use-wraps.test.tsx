import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { useWraps } from "@/hooks/useWraps";

afterEach(() => cleanup());

/** Words laid out on `lines` lines of 22px, as a browser would report them. */
function Words({ lines }: { lines: number }) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const wraps = useWraps(ref);
  return (
    <p
      ref={(el) => {
        ref.current = el;
        if (el) Object.defineProperty(el, "clientHeight", { configurable: true, value: lines * 22 });
      }}
      style={{ lineHeight: "22px" }}
    >
      {wraps ? "wraps" : "one line"}
    </p>
  );
}

describe("useWraps", () => {
  test("one line, or more, as the browser lays the text out", () => {
    const real = globalThis.ResizeObserver;
    // A browser reports an observed element's size once it is laid out.
    globalThis.ResizeObserver = class {
      constructor(private readonly report: ResizeObserverCallback) {}
      observe() {
        this.report([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      expect(render(<Words lines={1} />).container.textContent).toBe("one line");
      cleanup();
      expect(render(<Words lines={2} />).container.textContent).toBe("wraps");
    } finally {
      globalThis.ResizeObserver = real;
    }
  });
});
