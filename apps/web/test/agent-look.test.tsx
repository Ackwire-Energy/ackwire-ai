import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { Avatar, normalizeAppearance, randomAppearance } from "@agenteschat/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

/** The geometry of an accessory, one line per shape (a readable snapshot). */
function shapes(svg: Element | null) {
  if (!svg) return [];
  const g = (el: Element, ...names: string[]) => names.map((n) => el.getAttribute(n)).join(",");
  return [...svg.querySelectorAll("path, rect, circle, ellipse")].map((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "path") return `path ${el.getAttribute("d")}`;
    if (tag === "rect") return `rect ${g(el, "x", "y", "width", "height")}`;
    if (tag === "circle") return `circle ${g(el, "cx", "cy", "r")}`;
    return `ellipse ${g(el, "cx", "cy", "rx", "ry")}`;
  });
}

const drawn = (accessory: string, size: "xs" | "sm" | "md" | "lg" = "md") => {
  const { container } = render(
    <Avatar kind="agent" name="Theo" size={size} appearance={normalizeAppearance({ accessory })} />,
  );
  const avatar = container.querySelector(".ac-avatar") as HTMLElement;
  const svg = avatar.querySelector(`svg[data-accessory="${accessory}"]`);
  const out = { avatar, svg, shapes: shapes(svg) };
  cleanup();
  return out;
};

describe("accessories: one 100×100 box with the symbol", () => {
  test("each accessory's shapes", () => {
    expect(drawn("hat").shapes).toEqual([
      "rect 30,-30,40,32",
      "rect 33,-27,6,26",
      "rect 30,-6,40,7",
      "ellipse 50,2,31,5.5",
    ]);
    expect(drawn("cap").shapes).toEqual([
      "path M22 6 C22 -14 78 -14 78 6 Z",
      "path M50 -9 V6",
      "circle 50,-9,2.5",
      "path M60 4 C80 2 96 6 98 11 C86 12 70 10 58 9 Z",
    ]);
    expect(drawn("glasses").shapes).toEqual([
      "circle 34.5,50,12",
      "circle 65.5,50,12",
      "path M46.5 48 Q50 45 53.5 48",
      "path M22.5 48 L10 45 M77.5 48 L90 45",
    ]);
    expect(drawn("sunglasses").shapes).toEqual([
      "rect 21,41,27,17",
      "rect 52,41,27,17",
      "path M25 45 L31 45 M56 45 L62 45",
      "rect 47,45,6,3",
      "path M22.5 48 L10 45 M77.5 48 L90 45",
    ]);
    expect(drawn("headphones").shapes).toEqual([
      "path M10 44 C10 -8 90 -8 90 44",
      "rect -2,36,16,28",
      "rect 86,36,16,28",
      "rect 9,39,5,22",
      "rect 86,39,5,22",
    ]);
    expect(drawn("bow").shapes).toEqual([
      "path M76 4 L60 -6 L60 14 Z",
      "path M76 4 L92 -6 L92 14 Z",
      "path M76 4 L64 0 L64 8 Z",
      "path M76 4 L88 0 L88 8 Z",
      "circle 76,4,4.5",
    ]);
    expect(drawn("crown").shapes).toEqual([
      "path M27 6 L27 -14 L38.5 -3 L50 -20 L61.5 -3 L73 -14 L73 6 Z",
      "rect 27,1,46,6",
      "circle 50,-1,3",
      "circle 38,2,2",
      "circle 62,2,2",
    ]);
  });

  test("tilts: the hat −4° on its brim, the bow 18° on its knot", () => {
    expect(drawn("hat").svg?.querySelector("g")?.getAttribute("transform")).toBe("rotate(-4 50 2)");
    expect(drawn("bow").svg?.querySelector("g")?.getAttribute("transform")).toBe("rotate(18 76 4)");
  });

  test("glasses live in the eyes' group (they look around together); hats don't", () => {
    const glasses = drawn("glasses");
    expect(glasses.svg?.parentElement?.classList.contains("ac-avatar__face")).toBe(true);
    expect(glasses.svg?.parentElement?.querySelectorAll(".ac-avatar__eye")).toHaveLength(2);
    const hat = drawn("hat");
    expect(hat.svg?.parentElement?.classList.contains("ac-avatar")).toBe(true);
    // Sunglasses hide the eyes (CSS keys off this).
    expect(drawn("sunglasses").avatar.getAttribute("data-accessory")).toBe("sunglasses");
  });

  test("≤ 24px: no highlights, glints or gems; strokes stay 1.5px on screen", () => {
    expect(drawn("hat", "sm").shapes).toEqual(["rect 30,-30,40,32", "rect 30,-6,40,7", "ellipse 50,2,31,5.5"]);
    expect(drawn("crown", "xs").shapes).toEqual([
      "path M27 6 L27 -14 L38.5 -3 L50 -20 L61.5 -3 L73 -14 L73 6 Z",
      "rect 27,1,46,6",
    ]);
    expect(drawn("sunglasses", "sm").shapes).not.toContain("path M25 45 L31 45 M56 45 L62 45");
    expect(drawn("sunglasses", "sm").svg?.hasAttribute("data-simple")).toBe(true);
    const lens = drawn("glasses", "sm").svg?.querySelector("circle");
    expect(lens?.getAttribute("stroke-width")).toBe("1.5");
    expect(lens?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    // Big enough: the drawn stroke scales with the symbol.
    const big = drawn("glasses", "lg").svg?.querySelector("circle");
    expect(big?.getAttribute("stroke-width")).toBe("3.5");
    expect(big?.hasAttribute("vector-effect")).toBe(false);
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
    expect(a.querySelector('svg.ac-avatar__accessory[data-accessory="crown"]')).not.toBeNull();
    expect(a.className).toContain("ac-avatar--thinking");
    expect(a.querySelectorAll(".ac-avatar__eye")).toHaveLength(2);
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
    expect(preview.querySelector('[data-accessory="crown"]')).not.toBeNull();
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
