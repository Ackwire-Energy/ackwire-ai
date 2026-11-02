import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { helpDocument } from "@agenteschat/i18n/help";
import { legalDocument } from "@agenteschat/i18n/legal";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Block } from "@/pages/help/HelpPage";
import { LegalPage } from "@/pages/LegalPage";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const signedOut = () => createFakeApi(seedState({ me: null }));
const OWN = { termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy" };
/** A server that isn't agentes.chat's, with these legal links of its own. */
const ownServer = (authConfig: Partial<typeof OWN> = {}) =>
  createFakeApi(seedState({ me: null, instance: { cloud: false, url: "https://chat.example.com" }, authConfig }));
/** agentes.chat Cloud, with the legal links its servers set by default: on another address than this browser's. */
const cloud = () =>
  createFakeApi(
    seedState({
      me: null,
      authConfig: { termsUrl: "https://app.agentes.chat/terms", privacyUrl: "https://app.agentes.chat/privacy" },
    }),
  );

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
    // Every app language has the help pages: ?lang=fr is the French page.
    await renderApp("/help/wiki?lang=fr", { api: signedOut() });
    expectPage(helpDocument("wiki", "fr"));
    expect(document.querySelector(".help")?.getAttribute("lang")).toBe("fr");
  });

  test("the language switch changes the page and the address's lang, never the app's language", async () => {
    const { router, services } = await renderApp("/help/approvals?lang=en", { api: signedOut() });
    const app = services.i18n.language;
    expectPage(helpDocument("approvals", "en"));
    await pick(screen().getByRole("combobox", { name: "Language" }), "Português (Brasil)");
    expect(router.state.location.pathname).toBe("/help/approvals");
    expect(router.state.location.search).toEqual({ lang: "pt-BR" });
    expectPage(helpDocument("approvals", "pt-BR"));
    await pick(screen().getByRole("combobox", { name: "Idioma" }), "English");
    expect(router.state.location.search).toEqual({ lang: "en" });
    expectPage(helpDocument("approvals", "en"));
    expect(services.i18n.language).toBe(app);
    expect(localStorage.getItem("agentes.locale")).toBeNull();
  });

  test("code reads as code: a path in a line, and a command in a block of its own", async () => {
    await renderApp("/help/run-on-your-computer?lang=en", { api: signedOut() });
    expect([...document.querySelectorAll(".help__doc p code")].map((c) => c.textContent)).toContain(".agentes");
    cleanup();
    render(<Block block={{ code: "curl -fsSL https://agentes.chat/install | sh" }} />);
    expect(document.querySelector("pre > code")?.textContent).toBe("curl -fsSL https://agentes.chat/install | sh");
    expect(document.querySelector("pre a")).toBeNull();
  });

  test("an unknown page goes home: sign-in when signed out, the workspace when signed in", async () => {
    const { router } = await renderApp("/help/nope?lang=en", { api: signedOut() });
    await settle();
    expect(router.state.location.pathname).toBe("/login");
    cleanup();
    const signedIn = await renderApp("/help/nope?lang=en", { api: createFakeApi() });
    await settle();
    expect(signedIn.router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
  });

  test("the tab reads the page's title while it shows, and what it read before once it's left", async () => {
    document.title = "agentes.chat";
    const { router } = await renderApp("/help/memory?lang=en", { api: signedOut() });
    expect(document.title).toBe("Memory · agentes.chat");
    await act(async () => fireEvent.click(document.querySelector(".help .legal__bar a") as HTMLElement));
    await settle();
    expect(router.state.location.pathname).toBe("/login");
    expect(document.title).toBe("agentes.chat");
    cleanup();
    // The Terms and the Privacy Policy, the same way.
    await renderPage(<LegalPage kind="terms" />, { api: signedOut() });
    expect(document.title).toBe(`${legalDocument("terms", "en").title} · agentes.chat`);
    cleanup();
    expect(document.title).toBe("agentes.chat");
  });
});

describe("the Terms and the Privacy Policy", () => {
  test("agentes.chat Cloud's, where the server says it is the Cloud, whatever the browser's address", async () => {
    expect(window.location.origin).toBe("http://localhost:3000");
    const replace = spyOn(window.location, "replace").mockImplementation(() => {});
    try {
      for (const kind of ["terms", "privacy"] as const) {
        await renderApp(`/${kind}`, { api: cloud() });
        expect(screen().getByRole("heading", { level: 1, name: legalDocument(kind, "en").title })).toBeTruthy();
        cleanup();
      }
      const { router } = await renderApp("/termos", { api: cloud() });
      expect(router.state.location.pathname).toBe("/terms");
      expect(screen().getByRole("heading", { level: 1, name: legalDocument("terms", "en").title })).toBeTruthy();
      expect(replace).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
    }
  });

  test("any other server sends each to its own page, and shows none of the Cloud's", async () => {
    const replace = spyOn(window.location, "replace").mockImplementation(() => {});
    try {
      await renderApp("/terms", { api: ownServer(OWN) });
      expect(replace.mock.calls.map(([url]) => String(url))).toEqual([OWN.termsUrl]);
      expect(screen().queryByRole("heading", { level: 1 })).toBeNull();
      cleanup();
      await renderApp("/privacidade", { api: ownServer(OWN) });
      expect(replace.mock.calls.map(([url]) => String(url))).toEqual([OWN.termsUrl, OWN.privacyUrl]);
      expect(screen().queryByRole("heading", { level: 1 })).toBeNull();
    } finally {
      replace.mockRestore();
    }
  });

  test("without a page of its own it says so, and where to ask", async () => {
    const replace = spyOn(window.location, "replace").mockImplementation(() => {});
    try {
      await renderApp("/terms", { api: ownServer({ privacyUrl: OWN.privacyUrl }) });
      expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Este servidor não tem página de termos");
      expect(screen().getByText("Precisa de ajuda? Fale com quem cuida deste servidor.")).toBeTruthy();
      cleanup();
      await renderApp("/privacy", { api: ownServer({ termsUrl: OWN.termsUrl }) });
      expect(screen().getByRole("heading", { level: 1 }).textContent).toBe(
        "Este servidor não tem página de privacidade",
      );
      cleanup();
      // An address of this same server would only come back here.
      await renderApp("/terms", { api: ownServer({ termsUrl: "http://localhost:3000/terms" }) });
      expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Este servidor não tem página de termos");
      expect(replace).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
    }
  });

  test("a help page's footer links the server's own pages, only when it has both", async () => {
    await renderApp("/help/memory?lang=en", { api: ownServer(OWN) });
    const footer = document.querySelector(".help__foot");
    expect([...(footer?.querySelectorAll("a") ?? [])].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Terms", OWN.termsUrl],
      ["Privacy policy", OWN.privacyUrl],
    ]);
    cleanup();
    for (const one of [{ termsUrl: OWN.termsUrl }, { privacyUrl: OWN.privacyUrl }, {}]) {
      await renderApp("/help/memory?lang=en", { api: ownServer(one) });
      expect(document.querySelector(".help__foot")).toBeNull();
      cleanup();
    }
  });
});
