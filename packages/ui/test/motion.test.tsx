import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { LIST_STAGGER_MS, List } from "../src";

afterEach(() => cleanup());

const css = () => Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("motion", () => {
  test("enter transitions are short and live only inside a no-preference block", async () => {
    const all = await css();
    const section = all.slice(all.indexOf("Motion (2026-10)"));
    expect(section.length).toBeGreaterThan(100);
    const outside = section.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
    expect(outside).not.toMatch(/\banimation(-name)?:/);
    // 120–200 ms, opacity and transform only (no layout properties in the keyframes).
    for (const ms of section.matchAll(/animation: [a-z-]+ (\d+)ms/g)) {
      expect(Number(ms[1])).toBeGreaterThanOrEqual(120);
      expect(Number(ms[1])).toBeLessThanOrEqual(200);
    }
    const keyframes = section.match(/@keyframes[\s\S]*$/)?.[0] ?? "";
    expect(keyframes).not.toMatch(/\b(width|height|top|left|margin|padding):/);
  });

  test("a list staggers its rows only when it first appears", async () => {
    const { container } = render(
      <List>
        <div>Ada</div>
        <div>Atlas</div>
      </List>,
    );
    const list = container.querySelector(".ac-list") as HTMLElement;
    expect(list.classList.contains("ac-list--stagger")).toBe(true);
    await wait(LIST_STAGGER_MS + 30);
    expect(list.classList.contains("ac-list--stagger")).toBe(false);
  });
});
