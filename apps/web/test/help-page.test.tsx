import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { helpDocument } from "@agenteschat/i18n/help";
import { legalDocument } from "@agenteschat/i18n/legal";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Block } from "@/pages/help/HelpPage";
import { LegalPage } from "@/pages/LegalPage";
import { createFakeApi, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

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
  test("/help/memory?lang=en: the English page, sections at their anchors", async () => {
    const { router } = await renderApp("/help/memory?lang=en", { api: signedOut() });
    expect(router.state.location.pathname).toBe("/help/memory");
    expectPage(helpDocument("memory", "en"));
    expect(document.title).toBe("Memory · agentes.chat");
    expect(document.querySelector(".help")?.getAttribute("lang")).toBe("en");
    // Its labels follow the page's language, not the app's (Portuguese here).
    expect(screen().getByRole("link", { name: "Go to the home page" })).toBeTruthy();
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
    expect(document.querySelector(".help")?.getAttribute("lang")).toBe("pt-BR");
  });

  test("the language switch changes the page and the address's lang", async () => {
    const { router, services } = await renderApp("/help/approvals?lang=en", { api: signedOut() });
    expectPage(helpDocument("approvals", "en"));
    await act(async () => fireEvent.click(screen().getByRole("radio", { name: "Português (Brasil)" })));
    await settle();
    expect(router.state.location.pathname).toBe("/help/approvals");
    expect(router.state.location.search).toEqual({ lang: "pt-BR" });
    expectPage(helpDocument("approvals", "pt-BR"));
    expect(services.i18n.language).toBe("pt-BR");
    await act(async () => fireEvent.click(screen().getByRole("radio", { name: "English" })));
    await settle();
    expect(router.state.location.search).toEqual({ lang: "en" });
    expectPage(helpDocument("approvals", "en"));
    expect(services.i18n.language).toBe("en");
  });

  test("code reads as code: a path in a line, and a command in a block of its own", async () => {
    await renderApp("/help/run-on-your-computer?lang=en", { api: signedOut() });
    expect([...document.querySelectorAll(".help__doc p code")].map((c) => c.textContent)).toContain(".agentes");
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

  test("the tab reads the page's title while it shows, and what it read before once it's left", async () => {
    document.title = "agentes.chat";
    const { router } = await renderApp("/help/memory?lang=en", { api: signedOut() });
    expect(document.title).toBe("Memory · agentes.chat");
    await act(async () => fireEvent.click(document.querySelector(".help .legal__bar a") as HTMLElement));
    await settle();
    expect(router.state.location.pathname).toBe("/");
    expect(document.title).toBe("agentes.chat");
    cleanup();
    // The Terms and the Privacy Policy, the same way.
    await renderPage(<LegalPage kind="terms" />, { api: signedOut() });
    expect(document.title).toBe(`${legalDocument("terms", "en").title} · agentes.chat`);
    cleanup();
    expect(document.title).toBe("agentes.chat");
  });
});
