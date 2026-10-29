import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { HELP_PAGES, type HelpSlug } from "@agenteschat/i18n/help";
import { cleanup, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { HelpLink } from "@/components/HelpLink";
import { createI18n } from "@/i18n";
import { HelpPage } from "@/pages/help/HelpPage";
import { LegalPage } from "@/pages/LegalPage";
import { createFakeApi, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(cleanup);

describe("links read as ours, never the browser's blue", () => {
  test("the addresses inside the Terms and the Privacy Policy are house links", async () => {
    for (const kind of ["terms", "privacy"] as const) {
      await renderPage(<LegalPage kind={kind} />, { api: createFakeApi(seedState({ me: null })) });
      await settle();
      const links = [...document.querySelectorAll(".legal__doc a")];
      expect(links.length).toBeGreaterThan(0);
      for (const a of links) expect(a.className).toBe("ac-link");
      cleanup();
    }
  });

  test("so are the links inside every help page", async () => {
    let seen = 0;
    for (const slug of Object.keys(HELP_PAGES) as HelpSlug[])
      for (const lang of ["en", "pt-BR"] as const) {
        await renderPage(<HelpPage slug={slug} lang={lang} />, { api: createFakeApi(seedState({ me: null })) });
        await settle();
        for (const a of document.querySelectorAll(".lp-help__doc a")) {
          expect({ slug, lang, className: a.className }).toEqual({ slug, lang, className: "ac-link" });
          seen++;
        }
        cleanup();
      }
    expect(seen).toBeGreaterThan(0);
  });

  test("a link to a help page is a help line's link, to a new tab with no referrer, carrying only the language and the section", () => {
    for (const [lng, lang] of [
      ["en", "en"],
      ["pt-BR", "pt-BR"],
    ] as const) {
      render(
        <I18nextProvider i18n={createI18n(lng)}>
          <HelpLink slug="computers" section="folders">
            How computers work
          </HelpLink>
        </I18nextProvider>,
      );
      const a = document.querySelector("a");
      expect(a?.className).toBe("ac-link ac-link--muted");
      expect(a?.getAttribute("target")).toBe("_blank");
      expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
      const url = new URL(a?.getAttribute("href") ?? "");
      expect(url.origin + url.pathname).toBe("https://app.agentes.chat/help/computers");
      expect([...url.searchParams]).toEqual([["lang", lang]]);
      expect(url.hash).toBe("#folders");
      cleanup();
    }
  });
});
