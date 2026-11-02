import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { cleanup, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

const ROOT = new URL("../../../", import.meta.url).pathname;

/** A message in #eng, `minutes` before now; people by user id ("u-walter" is me), agents by agent id. */
const said = (id: string, who: string, body: string, minutes: number, extra: Partial<Message> = {}) =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: who.startsWith("u-") ? { type: "person", id: who } : { type: "agent", id: who },
    body,
    mentionedAgentIds: [],
    agentRunId: who.startsWith("u-") ? null : `r-${id}`,
    createdAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    ...extra,
  }) as Message;

async function open(messages: Message[]) {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState({ messages })) });
  await settle(10);
}

const row = (id: string) => {
  const el = document.querySelector<HTMLElement>(`article[data-message-id="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
};

describe("my own messages sit on the right", () => {
  test("mine get the own class and their place in the run; others' rows stay as they were", async () => {
    await open([
      said("j1", "u-joao", "Bom dia!", 10),
      said("w1", "u-walter", "Vi o alerta também", 9),
      said("w2", "u-walter", "Estou no celular", 9),
      said("w3", "u-walter", "@ada consegue olhar?", 8, { mentionedAgentIds: [ADA_ID] }),
      said("a1", ADA_ID, "Olhando.", 7),
      said("w4", "u-walter", "Valeu", 6),
    ]);
    expect(
      ["w1", "w2", "w3", "w4"].map((id) => [row(id).classList.contains("ac-msg--own"), row(id).dataset.run]),
    ).toEqual([
      [true, "start"],
      [true, "mid"],
      [true, "end"],
      [true, "solo"],
    ]);
    for (const id of ["j1", "a1"]) {
      expect(row(id).classList.contains("ac-msg--own")).toBe(false);
      expect(row(id).dataset.run).toBeUndefined();
    }
    // No face; the name and time stay for screen readers, and the bar is still named after me.
    expect(row("w1").querySelector(".ac-msg__avatar")).toBeNull();
    const head = row("w1").querySelector(".ac-msg__body > div");
    expect(head?.className).toBe("ac-visually-hidden");
    expect(head?.textContent).toContain("Walter");
    expect(within(row("w1")).getByRole("toolbar", { name: "Ações da mensagem de Walter" })).toBeTruthy();
    // The time once per run, under its last row (never read twice).
    expect(["w1", "w2", "w3", "w4"].map((id) => Boolean(row(id).querySelector(".ac-msg__own-time")))).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(row("w3").querySelector(".ac-msg__own-time")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("a run's rows before its last keep their time for hover and keyboard, in the left column", async () => {
    await open([
      said("w1", "u-walter", "Vi o alerta também", 9),
      said("w2", "u-walter", "Estou no celular", 9),
      said("w3", "u-walter", "Já volto", 8),
    ]);
    expect(
      ["w1", "w2", "w3"].map((id) => row(id).querySelector(".ac-msg__gutter-time time")?.textContent ?? null),
    ).toEqual([
      row("w1").querySelector("time")?.textContent ?? "",
      row("w2").querySelector("time")?.textContent ?? "",
      null,
    ]);
    expect(row("w1").querySelector(".ac-msg__gutter-time")?.textContent).toMatch(/\d{2}:\d{2}/);
    // Never read twice: the hidden head reads it.
    expect(row("w1").querySelector(".ac-msg__gutter")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("something under a bubble ends the run's look: the next bubble doesn't square off against it", async () => {
    await open([
      said("w1", "u-walter", "Vi o alerta também", 9, {
        reactions: [{ reaction: "+1", count: 1, userIds: ["u-joao"] }] as Message["reactions"],
      }),
      said("w2", "u-walter", "Estou no celular", 9),
      said("w3", "u-walter", "Já volto", 8),
    ]);
    // The rule finds what hangs as the bubble's later siblings (its style is checked in Chrome: happy-dom's :has is
    // unreliable): the reactions here, and on the rows under it only the bar and an empty foot, which don't count.
    expect(row("w1").querySelector(".ac-msg__text ~ .ac-reacts")).toBeTruthy();
    for (const id of ["w2", "w3"])
      expect(
        [...row(id).querySelectorAll(".ac-msg__text ~ *")].every(
          (e) => e.matches(".ac-msg__actions") || e.childNodes.length === 0,
        ),
      ).toBe(true);
    const css = (await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text())
      .replace(/\s+/g, " ")
      .replace(/\( /g, "(")
      .replace(/ \)/g, ")");
    const hanging =
      ".ac-msg--own:has(> .ac-msg__body > .ac-msg__text ~ :not(.ac-msg__actions, .ac-msg__own-time:not(.ac-msg__status), :empty))";
    expect(css).toContain(`${hanging} { padding-bottom: 6px; }`);
    expect(css).toContain(`${hanging} .ac-msg__text { border-bottom-right-radius: 18px; }`);
    expect(css).toContain(`${hanging} + .ac-msg--own { padding-top: 6px; }`);
    expect(css).toContain(`${hanging} + .ac-msg--own .ac-msg__text { border-top-right-radius: 18px; }`);
  });

  test("a code block or a table takes the whole width; plain words stay a bubble", async () => {
    await open([
      said("w1", "u-walter", "Assim:\n\n```ts\nconst a = 1;\n```", 9),
      said("j1", "u-joao", "ok", 8),
      said("w2", "u-walter", "| a | b |\n| --- | --- |\n| 1 | 2 |", 7),
      said("j2", "u-joao", "ok", 6),
      said("w3", "u-walter", "só texto, com `código` e a | barra", 5),
    ]);
    expect(["w1", "w2", "w3"].map((id) => row(id).classList.contains("ac-msg--wide"))).toEqual([true, true, false]);
  });

  test("sending says so in the time's place; a send that failed keeps its words and Tentar de novo", async () => {
    await open([
      said("w1", "u-walter", "Mandando o resumo", 2, { local: "failed", clientId: "c-1" }),
      said("j1", "u-joao", "ok", 1),
      said("w2", "u-walter", "E o link", 0, { local: "pending", clientId: "c-2" }),
    ]);
    expect(row("w1").classList.contains("ac-msg--failed")).toBe(true);
    expect(row("w1").textContent).toContain("Não enviada");
    expect(within(row("w1")).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    expect(row("w2").classList.contains("ac-msg--pending")).toBe(true);
    const status = row("w2").querySelector(".ac-msg__own-time");
    expect(status?.classList.contains("ac-msg__status")).toBe(true);
    expect(status?.textContent).toContain("enviando");
    expect(status?.getAttribute("aria-hidden")).toBeNull();
  });
});

describe("own message styles", () => {
  const rules = async () => {
    const css = (await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const out = new Map<string, string>();
    for (const [, list = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      for (const raw of list.split(",")) {
        const selector = raw.trim().replace(/\s+/g, " ");
        out.set(selector, `${out.get(selector) ?? ""}${body}`);
      }
    return out;
  };

  test("the bar and the check stand left of the bubble, never over my words, the check always on screen", async () => {
    const r = await rules();
    const bar = r.get(
      ".ac-msg--own:has(> .ac-msg__body .ac-msg__aside:not(:empty)) > .ac-msg__body > .ac-msg__actions",
    );
    // The bar's middle on the bubble's top edge, as on everyone's rows.
    expect(bar).toContain("right: calc(100% + 8px)");
    expect(bar).toContain("top: 0");
    expect(r.get(".ac-msg--own > .ac-msg__body > .ac-msg__actions")).toContain("top: 0");
    // The check at the bubble's bottom edge: a zero-height item right after the bubble, its contents hanging up from it.
    const check = r.get(".ac-msg--own > .ac-msg__body > .ac-msg__aside--floating") ?? "";
    expect(check).toContain("right: calc(100% + 8px)");
    expect(check).toContain("height: 0");
    expect(check).toContain("align-items: flex-end");
    expect(check).toContain("order: 1");
    expect(r.get(".ac-msg--own > .ac-msg__body > .ac-msg__text ~ *")).toContain("order: 2");
    // No hover, focus or open menu hides it: a mouse can open a DM's "Vista por" face.
    const kit = (await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const own = [...kit.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, list = ""]) => list.includes(".ac-msg--own") && /\.ac-msg__aside--floating\s*$/.test(list),
    );
    expect(own.length).toBeGreaterThan(0);
    for (const [, , body = ""] of own) expect(body).not.toMatch(/opacity|visibility|display:\s*none/);
    // The keys on the check itself (a DM's face is a button): the bar gives way.
    const keys =
      "html:not([data-pointer]) .ac-msg--own:has(> .ac-msg__body > .ac-msg__aside--floating :focus-visible) > .ac-msg__body >";
    expect(r.get(`${keys} .ac-msg__actions`)).toContain("opacity: 0");
  });

  test("a narrow window keeps room for the bar left of the bubble; a touch screen's bar sits over its top edge", async () => {
    const r = await rules();
    // Beside a full-width bubble, at any width with a mouse, the 96px padding holds it (82px) left of the bubble.
    expect(r.get(".ac-msg--own")).toContain("padding-left: 96px");
    const css = await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text();
    // Any bubble may take a narrow row, so wrapped words, code, a table and a file share one left edge; a phone
    // keeps 64px of it, and with a mouse the time of a run's row goes under the bar standing there.
    expect(css).toContain("@media (max-width: 600px) {\n  .ac-msg--own > .ac-msg__body {\n    --own-max: 100%;");
    expect(css).toContain("@media (max-width: 600px) and (hover: none) {\n  .ac-msg--own {\n    padding-left: 64px;");
    expect(css).toContain(
      "@media (max-width: 600px) and (hover: hover) and (pointer: fine) {\n  .ac-msg--own > .ac-msg__gutter {\n    margin-top: 40px;",
    );
    const narrow = css.split("@media (hover: none), (pointer: coarse) {")[1]?.split("\n}")[0] ?? "";
    expect(narrow).toContain(".ac-msg--own > .ac-msg__body > .ac-msg__actions");
    expect(narrow).toContain("top: -4px;\n    right: 8px;");
    // Keyboard focus in my row opens its time's details (the head that has them is hidden).
    expect(css).toMatch(
      /\.ac-msg--own:has\(:focus-visible\) :is\(\.ac-msg__gutter-time, \.ac-msg__own-time\) > \.ac-msg__tip \{\s*visibility: visible;/,
    );
  });

  test("the bubble's colors come from the theme's tokens, and wide rows take the row", async () => {
    const r = await rules();
    const bubble = r.get(".ac-msg--own .ac-msg__text") ?? "";
    expect(bubble).toContain("background: var(--own-bubble)");
    expect(bubble).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(r.get(".ac-msg--own.ac-msg--wide > .ac-msg__body")).toContain("--own-max: 100%");
    // It may grow to the row but stays as wide as what it holds: a small table never sits in a wide empty bubble.
    expect(r.get(".ac-msg--own.ac-msg--wide > .ac-msg__body")).not.toContain("flex:");
    expect(r.get(".ac-msg--own.ac-msg--wide .ac-msg__text")).toBeUndefined();
    expect(r.get(".ac-msg--own > .ac-msg__body")).toContain("--own-max: min(70%, 640px)");
    expect(r.get(".ac-msg--own.ac-msg--failed .ac-msg__text")).toContain("var(--danger)");
  });
});

describe("code, tables and reactions on my bubble", () => {
  test("words and a code block in one message are one bubble, the code inside it", async () => {
    await open([
      said("j1", "u-joao", "Alguém olhou?", 9),
      said("w1", "u-walter", "Achei a consulta:\n\n```sql\ncreate index orders_idx on orders (created_at);\n```", 8),
    ]);
    const bubbles = row("w1").querySelectorAll(".ac-msg__text");
    expect(bubbles.length).toBe(1);
    expect(bubbles[0]?.querySelector("p")?.textContent).toBe("Achei a consulta:");
    expect(bubbles[0]?.querySelector(".code-card pre")?.textContent).toContain("create index");
    expect(row("w1").classList.contains("ac-msg--wide")).toBe(true);
  });

  test("a code card in a message is one plate: the kit's bare-pre plate stays off it, a table takes the page color", async () => {
    const css = (await Bun.file(`${ROOT}apps/web/src/layout.css`).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    const block = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    const code = block(".ac-msg__text .code-card__code");
    for (const decl of ["margin: 0;", "padding: 0 16px 14px;", "background: none;", "border-radius: 0;"])
      expect(code).toContain(decl);
    expect(block(".ac-msg--own .ac-msg__text .md__table")).toContain("background: var(--bg);");
    const kit = await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text();
    // As far from the bubble's top or bottom edge as from its sides.
    expect(kit).toContain(
      ".ac-msg--own .ac-msg__text .md > :is(.code-card, .md__table):first-child {\n  margin-top: 7px;",
    );
    expect(kit).toContain(
      ".ac-msg--own .ac-msg__text .md > :is(.code-card, .md__table):last-child {\n  margin-bottom: 7px;",
    );
  });

  test("the reactions' add button shows on touch screens for everyone's rows; mine only puts it first", async () => {
    const kit = await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text();
    expect(kit).toContain("@media (hover: none) {\n  .ac-react--add {\n    opacity: 1;");
    const own = kit.split("\n.ac-msg--own .ac-react--add {")[1]?.split("}")[0] ?? "";
    expect(own.trim()).toBe("order: -1;");
    await open([
      said("j1", "u-joao", "Alguém olhou?", 9, {
        reactions: [{ reaction: "+1", count: 1, userIds: ["u-walter"] }] as Message["reactions"],
      }),
      said("w1", "u-walter", "Olhei agora", 8, {
        reactions: [{ reaction: "+1", count: 1, userIds: ["u-joao"] }] as Message["reactions"],
      }),
    ]);
    for (const id of ["j1", "w1"]) expect(row(id).querySelector(".ac-reacts .ac-react--add")).toBeTruthy();
  });
});
