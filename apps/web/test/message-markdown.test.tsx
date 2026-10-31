import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { MessageBody } from "@/chat/MessageBody";
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

  test("words before inline code stay once as an answer streams past it, with their spaces", () => {
    const full = "Vou pedir `calendar:read` (ver a agenda), só leitura.";
    const r = render(<MessageBody body="" live />);
    for (let i = 1; i <= full.length; i++) {
      r.rerender(<MessageBody body={full.slice(0, i)} live />);
      // Written so far, the backticks of a closed code span gone.
      const shown = full.slice(0, i).replace(/`([^`]*)`/, "$1").trimEnd();
      expect(r.container.textContent).toBe(shown);
    }
  });
});
