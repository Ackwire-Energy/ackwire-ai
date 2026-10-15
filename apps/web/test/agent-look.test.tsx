import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ACCESSORIES, AGENT_ACCESSORIES, Avatar, normalizeAppearance, randomAppearance } from "@agenteschat/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

describe("accessories: pixel art from the agent engine", () => {
  test("every accessory the app offers is drawn by the engine; glasses are gone", () => {
    for (const a of AGENT_ACCESSORIES) if (a !== "none") expect(ACCESSORIES[a]).toBeTruthy();
    expect(AGENT_ACCESSORIES).not.toContain("glasses" as never);
    expect(normalizeAppearance({ accessory: "glasses" }).accessory).toBeUndefined();
    expect(normalizeAppearance({ accessory: "antenna" }).accessory).toBe("antenna");
  });
});

describe("the agent's look", () => {
  test("only known values; random differs from the current look", () => {
    expect(normalizeAppearance({ color: "rose", eyes: "laser", accessory: "crown", extra: 1 })).toEqual({
      color: "rose",
      eyes: undefined,
      accessory: "crown",
    });
    expect(normalizeAppearance(null)).toEqual({ color: undefined, eyes: undefined, accessory: undefined });
    let i = 0;
    const seq = [0, 0, 0, 0.5, 0.5, 0.5];
    const r = randomAppearance({ color: "sky", eyes: "round", accessory: "none" }, () => seq[i++ % seq.length] ?? 0);
    expect(r).not.toEqual({ color: "sky", eyes: "round", accessory: "none" });
  });

  test("the avatar draws color, eyes and the accessory, and keeps its live state", () => {
    const { container } = render(
      <Avatar
        kind="agent"
        name="Theo"
        size="sm"
        state="thinking"
        appearance={{ color: "rose", eyes: "happy", accessory: "crown" }}
      />,
    );
    const a = container.querySelector(".ac-avatar") as HTMLElement;
    expect(a.getAttribute("data-eyes")).toBe("happy");
    expect(a.style.getPropertyValue("--av-top")).toBeTruthy();
    expect(a.getAttribute("data-accessory")).toBe("crown");
    expect(a.className).toContain("ac-avatar--thinking");
    // The engine draws the agent on its canvas.
    expect(a.querySelector("canvas.ac-avatar__canvas")).not.toBeNull();
  });

  test("Aparência: pick color, eyes and accessory with a live preview; saves; the sidebar shows it", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    await click(screen().getByRole("button", { name: "Aparência" }));
    const dialog = screen().getByRole("dialog", { name: "Aparência da Ada" });
    const preview = within(dialog).getByRole("img", { name: "Ada" });
    await click(within(within(dialog).getByRole("radiogroup", { name: "Cor" })).getByRole("radio", { name: "Rosa" }));
    await click(
      within(within(dialog).getByRole("radiogroup", { name: "Olhos" })).getByRole("radio", { name: "Felizes" }),
    );
    await click(
      within(within(dialog).getByRole("radiogroup", { name: "Acessório" })).getByRole("radio", { name: "Coroa" }),
    );
    expect(preview.getAttribute("data-eyes")).toBe("happy");
    expect(preview.getAttribute("data-accessory")).toBe("crown");
    await click(
      within(within(dialog).getByRole("radiogroup", { name: "Ver como fica" })).getByRole("radio", {
        name: "Pensando",
      }),
    );
    expect(preview.className).toContain("ac-avatar--thinking");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      appearance: { color: "rose", eyes: "happy", accessory: "crown" },
    });
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(nav.querySelector('[data-accessory="crown"]')).not.toBeNull();
  });

  test("Aleatório changes the look (Salvar turns on)", async () => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    await click(screen().getByRole("button", { name: "Aparência" }));
    const dialog = screen().getByRole("dialog", { name: "Aparência da Ada" });
    expect((within(dialog).getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
    await click(within(dialog).getByRole("button", { name: "Aleatório" }));
    expect((within(dialog).getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
