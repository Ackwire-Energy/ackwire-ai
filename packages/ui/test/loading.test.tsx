import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, render, within } from "@testing-library/react";
import {
  Button,
  SKELETON_DELAY_MS,
  Skeleton,
  SkeletonConversation,
  SkeletonGroup,
  SkeletonList,
  TopProgress,
} from "../src";

afterEach(() => cleanup());

const body = () => within(document.body);
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("Skeleton", () => {
  test("a labelled status region; shapes are sized at once but shown only after the delay", async () => {
    render(
      <SkeletonGroup label="Carregando mensagens">
        <Skeleton width={120} />
      </SkeletonGroup>,
    );
    const group = body().getByRole("status", { name: "Carregando mensagens" });
    expect(group.getAttribute("aria-busy")).toBe("true");
    expect(group.hasAttribute("data-visible")).toBe(false);
    const shape = group.querySelector(".ac-skeleton") as HTMLElement;
    expect(shape.getAttribute("aria-hidden")).toBe("true");
    // Same size before and after it shows: no layout shift.
    expect(shape.style.width).toBe("120px");
    await wait(SKELETON_DELAY_MS + 30);
    expect(group.hasAttribute("data-visible")).toBe(true);
    expect(shape.style.width).toBe("120px");
  });

  test("a skeleton taking over from one on screen (the next stage of the same load) shows at once", async () => {
    const { rerender } = render(
      <SkeletonGroup key="first" label="Carregando a página">
        <Skeleton width={120} />
      </SkeletonGroup>,
    );
    await wait(SKELETON_DELAY_MS + 30);
    rerender(
      <SkeletonGroup key="next" label="Carregando mensagens">
        <Skeleton width={120} />
      </SkeletonGroup>,
    );
    expect(body().getByRole("status", { name: "Carregando mensagens" }).hasAttribute("data-visible")).toBe(true);
    // Long after it went: a new load waits again.
    cleanup();
    await wait(400);
    render(
      <SkeletonGroup label="Carregando a lista">
        <Skeleton width={120} />
      </SkeletonGroup>,
    );
    expect(body().getByRole("status", { name: "Carregando a lista" }).hasAttribute("data-visible")).toBe(false);
  });

  test("a conversation looks like messages: avatars (people round, agents square), names, grouped follow-ups", () => {
    render(<SkeletonConversation label="Carregando mensagens" count={6} />);
    const group = body().getByRole("status", { name: "Carregando mensagens" });
    expect(group.querySelectorAll(".ac-skeleton-msg")).toHaveLength(6);
    expect(group.querySelectorAll(".ac-skeleton-msg--grouped").length).toBeGreaterThan(0);
    expect(group.querySelectorAll(".ac-skeleton--square").length).toBeGreaterThan(0);
    expect(group.querySelectorAll(".ac-skeleton--circle").length).toBeGreaterThan(0);
  });

  test("list rows", () => {
    render(<SkeletonList label="Carregando a lista" count={3} trailing />);
    expect(
      body().getByRole("status", { name: "Carregando a lista" }).querySelectorAll(".ac-skeleton-row"),
    ).toHaveLength(3);
  });

  test("the top progress bar waits the same delay and goes away when done", async () => {
    const { rerender } = render(<TopProgress active label="Atualizando" />);
    expect(body().queryByRole("progressbar")).toBeNull();
    await wait(SKELETON_DELAY_MS + 30);
    expect(body().getByRole("progressbar", { name: "Atualizando" })).toBeTruthy();
    rerender(<TopProgress active={false} label="Atualizando" />);
    expect(body().queryByRole("progressbar")).toBeNull();
  });
});

describe("Button loading", () => {
  test("spinner inside, label kept (same width), busy and not clickable", () => {
    let clicks = 0;
    render(
      <Button variant="primary" loading onClick={() => clicks++}>
        Salvar
      </Button>,
    );
    const button = body().getByRole("button", { name: "Salvar" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.className).toContain("ac-btn--loading");
    expect(button.querySelector(".ac-pixspin")).toBeTruthy();
    expect(button.textContent).toBe("Salvar");
    button.click();
    expect(clicks).toBe(0);
  });

  test("not loading: no spinner, no aria-busy", () => {
    render(<Button>Salvar</Button>);
    const button = body().getByRole("button", { name: "Salvar" });
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.querySelector(".ac-pixspin")).toBeNull();
  });
});

describe("reduced motion", () => {
  test("every loading animation lives inside a no-preference block", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const start = css.indexOf("Loading: skeletons");
    expect(start).toBeGreaterThan(-1);
    const section = css.slice(start);
    // Strip the allowed blocks; no `animation:` may remain outside them.
    const outside = section.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
    expect(outside).not.toMatch(/\banimation:/);
  });
});
