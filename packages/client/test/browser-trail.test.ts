import { describe, expect, test } from "bun:test";
import {
  browserTrailHosts,
  browserTrailHref,
  browserTrailOf,
  browserTrailPages,
  browserTrailSpanMs,
} from "../src/browser/trail";

const step = (tool: string, at: string, detail?: string) => ({ tool, at: `2026-10-20T21:${at}:00.000Z`, detail });

describe("where the agent browsed (meta.browser)", () => {
  test("reads the steps, dropping anything malformed", () => {
    expect(browserTrailOf(undefined)).toEqual([]);
    expect(browserTrailOf({ browser: { steps: "x" } })).toEqual([]);
    expect(
      browserTrailOf({
        browser: {
          steps: [step("browser_open", "10", "airbnb.com.br"), { tool: 1 }, { tool: "browser_read", at: "no" }],
        },
      }),
    ).toEqual([{ tool: "browser_open", detail: "airbnb.com.br", at: "2026-10-20T21:10:00.000Z", failed: false }]);
  });

  test("groups the steps by page, lists each site once and measures the time", () => {
    const steps = browserTrailOf({
      browser: {
        steps: [
          step("browser_read", "09"),
          step("browser_open", "10", "airbnb.com.br"),
          step("browser_click", "11"),
          step("browser_open", "12", "airbnb.com.br/rooms/48213"),
          { ...step("browser_read", "15"), failed: true },
        ],
      },
    });
    const pages = browserTrailPages(steps);
    expect(pages.map((p) => [p.host, p.path, p.steps.length])).toEqual([
      [null, "", 1],
      ["airbnb.com.br", "", 2],
      ["airbnb.com.br", "/rooms/48213", 2],
    ]);
    expect(pages[2]?.steps[1]?.failed).toBe(true);
    expect(browserTrailHosts(steps)).toEqual(["airbnb.com.br"]);
    expect(browserTrailSpanMs(steps)).toBe(6 * 60_000);
  });

  test("only a plain host becomes a link", () => {
    expect(browserTrailHref("airbnb.com.br/rooms/1")).toBe("https://airbnb.com.br/rooms/1");
    expect(browserTrailHref("javascript:alert(1)")).toBeNull();
    expect(browserTrailHref(null)).toBeNull();
  });
});
