import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { BrainLogo, ProviderLogo } from "../src";
import { type MarkId, markOf, PROVIDER_MARKS } from "../src/brand/marks";

afterEach(() => cleanup());

const logo = (container: HTMLElement) => container.querySelector(".ac-brand") as HTMLElement;

describe("provider marks", () => {
  test("every mark renders its path on the 24×24 grid, in the brand's color or the theme's", () => {
    for (const id of Object.keys(PROVIDER_MARKS) as MarkId[]) {
      const { container } = render(<ProviderLogo id={id} size="sm" />);
      const el = logo(container);
      expect(el.dataset.mark).toBe(id);
      expect(el.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
      const d = el.querySelector("path")?.getAttribute("d") ?? "";
      expect(d).toBe(PROVIDER_MARKS[id].path);
      expect(d).toMatch(/^[Mm][\d.\s,a-zA-Z-]+$/);
      const color = PROVIDER_MARKS[id].color;
      if (color) expect(el.style.getPropertyValue("--brand")).toBe(color);
      else expect(el.classList.contains("ac-brand--mono")).toBe(true);
      cleanup();
    }
  });

  test("brains, executors and API providers find their maker's mark; anything else has none", () => {
    expect(markOf("claude_code")).toBe("claude");
    expect(markOf("claude")).toBe("claude");
    expect(markOf("codex")).toBe("openai");
    expect(markOf("anthropic")).toBe("anthropic");
    expect(markOf("moonshot")).toBe("kimi");
    expect(markOf("zai")).toBe("zai");
    for (const id of ["model", "agent", "mistral", "", null, undefined, "constructor", "__proto__", "toString"])
      expect(markOf(id)).toBeNull();
  });

  test("decorative unless labeled", () => {
    const quiet = logo(render(<ProviderLogo id="deepseek" />).container);
    expect(quiet.getAttribute("aria-hidden")).toBe("true");
    expect(quiet.getAttribute("role")).toBeNull();
    cleanup();
    const named = logo(render(<ProviderLogo id="deepseek" label="DeepSeek" />).container);
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe("DeepSeek");
    expect(named.hasAttribute("aria-hidden")).toBe(false);
    expect(named.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("an id without a mark shows its initial on a neutral tile", () => {
    const el = logo(render(<ProviderLogo id="mistral" size="sm" off />).container);
    expect(el.querySelector("svg")).toBeNull();
    expect(el.textContent).toBe("M");
    expect(el.dataset.mark).toBeUndefined();
    expect(el.className).toContain("ac-brand--mono");
    expect(el.className).toContain("ac-brand--off");
  });

  test("BrainLogo still draws Claude for Claude Code and OpenAI for Codex, at its sizes", () => {
    const claude = logo(render(<BrainLogo kind="claude_code" />).container);
    expect(claude.dataset.mark).toBe("claude");
    expect(claude.className).toContain("ac-brand--tile");
    expect(claude.querySelector("path")?.getAttribute("d")).toBe(PROVIDER_MARKS.claude.path);
    cleanup();
    const codex = logo(render(<BrainLogo kind="codex" size="sm" off label="Codex" />).container);
    expect(codex.dataset.mark).toBe("openai");
    expect(codex.className).toContain("ac-brand--sm");
    expect(codex.className).toContain("ac-brand--off");
    expect(codex.getAttribute("aria-label")).toBe("Codex");
  });
});
