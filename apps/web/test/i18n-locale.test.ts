import { beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { titledWithUnread } from "@agenteschat/client/lib/unread";
import { chooseLocale, createI18n, detectedLocale, readLocaleState, savedLocale, translateTabTitle } from "../src/i18n";

beforeEach(() => localStorage.clear());

describe("the language to start in (ADR 0122)", () => {
  test("this browser's pick, else the landing's cookie, else the browser's own, else English", () => {
    expect(savedLocale(["pt-PT"], "agentes_locale=en")).toBe("en");
    expect(savedLocale(["sv-SE"], "")).toBe("en");
    expect(savedLocale(["sv-SE", "pt-BR"], "")).toBe("pt-BR");
    expect(savedLocale(["fr-CA", "pt-BR"], "")).toBe("fr");
    expect(savedLocale(["en-US"], "agentes_locale=zh-Hans")).toBe("zh-Hans");
    expect(savedLocale(["en-US"], "a=1; agentes_locale=pt")).toBe("pt-BR");
    localStorage.setItem("agentes.locale", "pt-BR");
    expect(savedLocale(["en-US"], "agentes_locale=en")).toBe("pt-BR");
    // Automático: the browser's own, whatever the landing said.
    localStorage.setItem("agentes.locale", "auto");
    expect(savedLocale(["en-US"], "agentes_locale=pt")).toBe("en");
  });

  test("a pick made signed out waits for the next sign-in; one made signed in doesn't", () => {
    const i18n = createI18n("en");
    chooseLocale("pt-BR", i18n, false);
    expect(readLocaleState()).toEqual({ stored: "pt-BR", pending: true });
    chooseLocale("auto", i18n, true);
    expect(readLocaleState()).toEqual({ stored: "auto", pending: false });
    expect(detectedLocale(["sv-SE", "en"])).toBe("en");
    expect(detectedLocale(["zh-TW", "en"])).toBe("zh-Hans");
  });
});

describe("the tab's title", () => {
  test("follows the language, keeps the unread count in front and leaves a page's own title", async () => {
    const i18n = createI18n("en");
    translateTabTitle(i18n);
    expect(document.title).toBe("Ackwire AI · Your team and your agents, in the same conversation");
    document.title = titledWithUnread(document.title, 3).title;
    await i18n.changeLanguage("pt-BR");
    expect(document.title).toBe("(3) Ackwire AI · Seu time e seus agentes, na mesma conversa");
    document.title = "#general · Example";
    await i18n.changeLanguage("de");
    expect(document.title).toBe("#general · Example");
    // The page goes and puts back the title it found, an earlier language's.
    document.title = "(3) Ackwire AI · Your team and your agents, in the same conversation";
    await new Promise((done) => setTimeout(done, 0));
    expect(document.title).toBe("(3) Ackwire AI · Dein Team und deine Agenten, in derselben Unterhaltung");
  });
});
