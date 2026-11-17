import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addLiveBrain } from "../src/brain/live";
import { addLiveComputer } from "../src/computer/live";
import { switchTheme, THEME_SWITCHING_ATTR } from "../src/theme";

const ROOT = join(import.meta.dir, "../../..");
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => ext.test(f) && !f.includes("node_modules"))
    .map((f) => join(dir, f));
const STYLES = [
  ...files("packages/ui/src", /\.css$/),
  ...files("apps/web/src", /\.css$/),
  ...files("apps/desktop/src", /\.css$/),
];
/** Every rule as [selector, declarations], comments dropped. */
const rules = (path: string) =>
  [
    ...readFileSync(join(ROOT, path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map((m) => [m[1]?.trim() ?? "", m[2] ?? ""] as const);
const frame = () => new Promise((ok) => requestAnimationFrame(ok));

describe("switching the theme", () => {
  test("holds every transition off until the new colors have painted", async () => {
    const root = document.documentElement;
    root.dataset.theme = "dark";
    switchTheme("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.hasAttribute(THEME_SWITCHING_ATTR)).toBe(true);
    await frame();
    await frame();
    await frame();
    expect(root.hasAttribute(THEME_SWITCHING_ATTR)).toBe(false);
    // The same theme again changes nothing.
    switchTheme("light");
    expect(root.hasAttribute(THEME_SWITCHING_ATTR)).toBe(false);
  });

  test("the stylesheet turns transitions off under it, the pseudo-elements' too", () => {
    const off = rules("packages/ui/src/styles/components.css").find(([sel]) =>
      sel.includes(`[${THEME_SWITCHING_ATTR}]`),
    );
    expect(off?.[0]).toContain(`html[${THEME_SWITCHING_ATTR}] *::before`);
    expect(off?.[0]).toContain(`html[${THEME_SWITCHING_ATTR}] *::after`);
    expect(off?.[1]).toContain("transition: none !important");
  });

  test("the apps change the theme only through it (boot scripts before the first paint aside)", () => {
    const writers = [...files("apps/web/src", /\.tsx?$/), ...files("apps/desktop/src", /\.tsx?$/)].filter((f) =>
      /dataset\.theme\s*=[^=]|setAttribute\(\s*["']data-theme["']/.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(writers).toEqual([]);
  });

  test("still portraits (computers, engines) repaint in the same task the theme changes", async () => {
    const draws = { computer: 0, brain: 0 };
    const canvas = (kind: keyof typeof draws) => {
      const el = document.createElement("canvas");
      // The engines only need a context that takes fills.
      el.getContext = (() => {
        draws[kind]++;
        return new Proxy({}, { get: () => () => {}, set: () => true });
      }) as unknown as HTMLCanvasElement["getContext"];
      document.body.append(el);
      return el;
    };
    const stopComputer = addLiveComputer({
      canvas: canvas("computer"),
      look: () => ({ kind: "mac", state: "online" }),
    });
    const stopBrain = addLiveBrain({ canvas: canvas("brain"), look: () => ({ kind: "claude_code", state: "idle" }) });
    const before = { ...draws };
    switchTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    // MutationObserver callbacks run as a microtask: before any frame or timer.
    await Promise.resolve();
    expect(draws.computer).toBeGreaterThan(before.computer);
    expect(draws.brain).toBeGreaterThan(before.brain);
    stopComputer();
    stopBrain();
  });
});

describe("hover", () => {
  test("no control transitions `all` (a layout or paint property would animate with it)", () => {
    const offenders = STYLES.flatMap((path) =>
      rules(path)
        .filter(([, body]) => /transition(-property)?\s*:[^;]*\ball\b/.test(body))
        .map(([sel]) => `${path}: ${sel}`),
    );
    expect(offenders).toEqual([]);
  });

  test("nothing slides on its own hover, so a pointer on its edge never loses and regains it every frame", () => {
    const moves = /(^|[;\s])(transform\s*:[^;]*translate|translate\s*:\s*(?!none|0\b))/;
    const offenders = STYLES.flatMap((path) =>
      rules(path).flatMap(([sel, body]) =>
        moves.test(body)
          ? sel
              .split(",")
              // The hovered element itself (its last compound), not a part inside it.
              .filter((one) =>
                /:hover/.test(
                  one
                    .trim()
                    .split(/\s+|>|\+|~/)
                    .pop() ?? "",
                ),
              )
              .map((one) => `${path}: ${one.trim()}`)
          : [],
      ),
    );
    expect(offenders).toEqual([]);
  });

  test("a button's hover never changes its opacity, so a dimmed or disabled one never lights up under the mouse", () => {
    const offenders = STYLES.flatMap((path) =>
      rules(path).flatMap(([sel, body]) =>
        /(^|[;\s])opacity\s*:/.test(body)
          ? sel
              .split(",")
              .filter((one) => one.includes(".ac-btn") && one.includes(":hover") && !one.includes(":not(:disabled)"))
              .map((one) => `${path}: ${one.trim()}`)
          : [],
      ),
    );
    expect(offenders).toEqual([]);
  });
});
