import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { helpDocument } from "@agenteschat/i18n/help";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Block } from "@/pages/help/HelpPage";
import { createFakeApi, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const signedOut = () => createFakeApi(seedState({ me: null }));

/** The page's title, and each section's heading at its anchor. */
function expectPage(doc: ReturnType<typeof helpDocument>) {
  expect(screen().getByRole("heading", { level: 1, name: doc.title })).toBeTruthy();
  expect(screen().getByText(doc.summary)).toBeTruthy();
  for (const s of doc.sections) {
    expect(screen().getByRole("heading", { level: 2, name: s.heading }).closest("section")?.id).toBe(s.id);
  }
}

describe("help pages", () => {
  test("/help/memory?lang=en: the English page, sections at their anchors, in the landing's dark look", async () => {
    const { router } = await renderApp("/help/memory?lang=en", { api: signedOut() });
    expect(router.state.location.pathname).toBe("/help/memory");
    expectPage(helpDocument("memory", "en"));
    expect(document.title).toBe("Memory · agentes.chat");
    const page = document.querySelector(".lp-help");
    expect(page?.getAttribute("data-theme")).toBe("dark");
    expect(page?.getAttribute("lang")).toBe("en");
    // Its labels follow the page's language, not the app's (Portuguese here).
    expect(screen().getByRole("button", { name: "Switch theme" })).toBeTruthy();
  });

  test("?lang=pt-BR is the Portuguese page; without it, the app's language", async () => {
    await renderApp("/help/memory?lang=pt-BR", { api: signedOut() });
    expectPage(helpDocument("memory", "pt-BR"));
    expect(document.title).toBe("Memória · agentes.chat");
    cleanup();
    await renderApp("/help/wiki", { api: signedOut() });
    expectPage(helpDocument("wiki", "pt-BR"));
    cleanup();
    // A language the site doesn't speak is the app's too.
    await renderApp("/help/wiki?lang=fr", { api: signedOut() });
    expectPage(helpDocument("wiki", "pt-BR"));
    expect(document.querySelector(".lp-help")?.getAttribute("lang")).toBe("pt-BR");
  });

  test("the language switch changes the page and the address's lang", async () => {
    const { router, services } = await renderApp("/help/approvals?lang=en", { api: signedOut() });
    expectPage(helpDocument("approvals", "en"));
    await act(async () => fireEvent.click(screen().getByRole("radio", { name: "PT" })));
    await settle();
    expect(router.state.location.pathname).toBe("/help/approvals");
    expect(router.state.location.search).toEqual({ lang: "pt-BR" });
    expectPage(helpDocument("approvals", "pt-BR"));
    expect(services.i18n.language).toBe("pt-BR");
    await act(async () => fireEvent.click(screen().getByRole("radio", { name: "EN" })));
    await settle();
    expect(router.state.location.search).toEqual({ lang: "en" });
    expectPage(helpDocument("approvals", "en"));
    expect(services.i18n.language).toBe("en");
  });

  test("code reads as code: a path in a line, and a command in a block of its own", async () => {
    await renderApp("/help/run-on-your-computer?lang=en", { api: signedOut() });
    expect([...document.querySelectorAll(".lp-help__doc p code")].map((c) => c.textContent)).toContain("~/.agentes");
    cleanup();
    render(<Block block={{ code: "curl -fsSL https://agentes.chat/install | sh" }} />);
    expect(document.querySelector("pre > code")?.textContent).toBe("curl -fsSL https://agentes.chat/install | sh");
    expect(document.querySelector("pre a")).toBeNull();
  });

  test("an unknown page goes to /", async () => {
    const { router } = await renderApp("/help/nope?lang=en", { api: signedOut() });
    await settle();
    expect(router.state.location.pathname).toBe("/");
  });
});
