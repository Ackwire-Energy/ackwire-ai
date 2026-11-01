import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { join } from "node:path";
import type { Approval, Message } from "@agenteschat/client";
import { mentionsHandle } from "@agenteschat/client/lib/markdown";
import { apiProviderOf } from "@agenteschat/client/lib/providers";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { InlineApproval } from "@/components/ApprovalItem";
import { declarations, topLevel } from "./built-css";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const ROOT = join(import.meta.dir, "../../..");
const sheet = async (...paths: string[]) =>
  topLevel((await Promise.all(paths.map((p) => Bun.file(join(ROOT, p)).text()))).join("\n"));
const value = (css: string, selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];

const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

describe("a message that mentions me", () => {
  test("its row is tinted with an accent bar and my chip stands out; a mention of someone else stays plain", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-me",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "@walter pode revisar o PR? @ada já olhou",
      mentionedAgentIds: [ADA_ID],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    } as Message);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(row("m-me").classList.contains("ac-msg--mentions-me")).toBe(true);
    const chips = [...row("m-me").querySelectorAll(".ac-mention")].map((c) => [c.textContent, c.className]);
    expect(chips).toEqual([
      ["@Walter", "ac-mention ac-mention--me"],
      ["@Ada", "ac-mention"],
    ]);
    // m-1 mentions only Ada.
    expect(row("m-1").classList.contains("ac-msg--mentions-me")).toBe(false);
  });

  test("the handle matches as the backend reads it: any case, never inside an email", () => {
    expect(mentionsHandle("oi @Walter, tudo bem?", "walter")).toBe(true);
    expect(mentionsHandle("mande para walter@acme.com", "walter")).toBe(false);
    expect(mentionsHandle("@walterx", "walter")).toBe(false);
  });

  test("the row's tint, its bar and the chip's shape", async () => {
    const css = await sheet("packages/ui/src/styles/components.css", "apps/web/src/layout.css");
    const me = ".channel__messages .ac-msg--mentions-me";
    expect(value(css, me, "box-shadow")).toBe("inset 2px 0 0 var(--attention)");
    expect(value(css, me, "background")).toContain("var(--attention) 9%");
    expect(value(css, ".ac-mention", "padding")).toBe("0 4px");
    expect(value(css, ".ac-mention", "border-radius")).toBe("var(--radius-sm)");
    expect(value(css, ".ac-mention--me", "color")).toBe("var(--attention)");
  });
});

describe("Fixar mensagem", () => {
  test("from the right click it pins through the pins API and says so; a pinned one offers Desafixar", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const pins: [string, string, string][] = [];
    api.pins = {
      list: async () => [],
      pin: async (_orgId, channelId, messageId) => {
        pins.push(["pin", channelId, messageId]);
        const m = state.messages.find((x) => x.id === messageId);
        if (m) m.pinned = true;
        return { messageId, channelId, pinnedBy: "u-walter", pinnedAt: new Date().toISOString() } as never;
      },
      unpin: async (_orgId, channelId, messageId) => {
        pins.push(["unpin", channelId, messageId]);
      },
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    await act(async () => fireEvent.contextMenu(row("m-1"), { clientX: 40, clientY: 60 }));
    await settle(2);
    await act(async () =>
      fireEvent.click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Fixar mensagem" })),
    );
    await settle(6);
    expect(pins).toEqual([["pin", ENG_ID, "m-1"]]);
    expect(document.body.textContent).toContain("Mensagem fixada.");
    await act(async () => fireEvent.contextMenu(row("m-1"), { clientX: 40, clientY: 60 }));
    await settle(2);
    await act(async () =>
      fireEvent.click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Desafixar mensagem" })),
    );
    await settle(4);
    expect(pins.at(-1)).toEqual(["unpin", ENG_ID, "m-1"]);
  });
});

describe("official provider logos", () => {
  const models = [
    { id: "claude-sonnet-5-5", label: "Sonnet", provider: "anthropic", available: true },
    { id: "gpt-5", label: "GPT-5", provider: "openai", available: false },
  ].map((m) => ({ ...m, inputUsdPerMTok: 1, outputUsdPerMTok: 1 }));

  test("whose API a model runs on; Automático, the one provider the workspace can use", () => {
    expect(apiProviderOf("gpt-5", models)).toBe("openai");
    expect(apiProviderOf("auto", models)).toBe("anthropic");
    expect(
      apiProviderOf(
        "auto",
        models.map((m) => ({ ...m, available: true })),
      ),
    ).toBeUndefined();
    expect(apiProviderOf("unknown", models)).toBeUndefined();
  });

  test("the DM header shows the API model's maker, not a generic brain", async () => {
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const brain = document.querySelector(".channel__brain") as HTMLElement;
    expect(brain.querySelector(".ac-brand")).toBeTruthy();
    expect(brain.textContent).toContain("Claude Sonnet 5.5");
  });

  test("the agent page's Pensa com shows the API model's maker", async () => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(10);
    const cells = [...document.querySelectorAll(".agp-cell")] as HTMLElement[];
    const brain = cells.find((c) => c.textContent?.includes("Claude Sonnet 5.5"));
    expect(brain?.querySelector(".agp-cell__key .ac-brand")).toBeTruthy();
  });
});

describe("agent faces in a line of text", () => {
  test(".ac-who: a face at the text's size, centred on the capitals", async () => {
    const css = await sheet("packages/ui/src/styles/components.css");
    const face = ".ac-who > .ac-avatar";
    expect(value(css, face, "font-size")).toBe("inherit");
    expect(value(css, face, "width")).toBe("1.15em");
    expect(value(css, face, "height")).toBe("1.15em");
    expect(value(css, ".ac-who", "white-space")).toBe("nowrap");
  });

  test("an approval's 'Ada pede aprovação' carries Ada's face before her name", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const approval = state.approvals.find((a) => a.id === "ap-merge") as Approval;
    const agent = (await api.agents.list(ORG_ID)).find((a) => a.id === ADA_ID);
    await renderPage(<InlineApproval approval={approval} agent={agent} members={new Map()} />, { api, org: true });
    await settle(4);
    const who = document.querySelector(".ac-who") as HTMLElement;
    expect(who.querySelector(".ac-avatar--xs")).toBeTruthy();
    expect(who.querySelector("b")?.textContent).toBe("Ada");
    expect(document.body.textContent).toContain("Ada pede aprovação");
  });
});

describe("the agent page's cards and the chat's", () => {
  test("agent cards: 12px above and below, the head pulled into the padding", async () => {
    const css = await sheet("apps/web/src/layout.css");
    expect(value(css, ".agp-card.ac-card", "padding-block")).toBe("12px");
    expect(value(css, ".agp-card>.ac-card__head:first-child", "margin-block")).toBe("-6px -2px");
    expect(value(css, ".agp-aside__work", "padding")).toBe("12px 20px");
  });

  test("the cards beside them use the same 12px", async () => {
    const css = await sheet(
      "apps/web/src/pages/approvals.css",
      "apps/web/src/pages/wiki.css",
      "apps/web/src/pages/drive.css",
      "apps/web/src/components/computer/computer.css",
    );
    expect(value(css, ".ap-waiters", "padding")).toBe("12px 16px");
    expect(value(css, ".wiki-import-card", "padding")).toBe("12px");
    expect(value(css, ".wiki-backlink", "padding")).toBe("12px");
    expect(value(css, ".drive-note", "padding")).toBe("12px 14px");
    expect(value(css, ".cmp-entry__row.ac-faceline", "padding")).toBe("12px 14px");
  });

  test("the computer card's words centred on its icon; the take-control head's icon on its two lines", async () => {
    const css = await sheet("apps/web/src/components/computer/computer.css");
    expect(value(css, ".cmp-entry__row.ac-faceline", "align-items")).toBe("center");
    expect(value(css, ".cmp-entry__t>.ac-captop", "margin-block-start")).toBe("0");
    expect(declarations(css, ".cmp-entry__row>.ac-computer")).toEqual([]);
    const lead = ".cmp-dialog .ac-dialog__lead:has(+ .ac-dialog__titles)";
    expect(value(css, lead, "align-self")).toBe("center");
    expect(value(css, lead, "translate")).toBe("none");
  });

  test("the working bar's faces open the pill as far in as the globe at its end", async () => {
    const css = await sheet("apps/web/src/layout.css");
    expect(
      value(
        css,
        '.ac-typing[data-active="true"]:has(> .ac-typing__avatars):not(:has(> .ac-typing__dots, > .ac-pixspin))',
        "padding-left",
      ),
    ).toBe("7px");
  });
});
