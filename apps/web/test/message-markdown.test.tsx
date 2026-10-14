import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { MessageBody } from "@/chat/MessageBody";
import { renderInline } from "@/lib/markdown";
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
