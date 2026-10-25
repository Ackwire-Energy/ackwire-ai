import { describe, expect, test } from "bun:test";
import type { BrowserHandoff, ComputerSetup } from "@agenteschat/client";
import {
  type AgentComputerFacts,
  type EntryWords,
  entryLine,
  entryState,
} from "@agenteschat/client/lib/agent-computer";
import { type SetupView, setupEta, setupView } from "@agenteschat/client/lib/computer";
import { clockAt } from "@agenteschat/client/lib/format";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { bannedIn, CLOUD_BANNED } from "../../../../packages/i18n/test/edition-words";
import { pageGapKey, stepText } from "../../src/features/browser/logic";
import {
  offersSwitch,
  onScreen,
  phoneEntryButton,
  phoneStage,
  screenRequest,
  setupNoticeLine,
} from "../../src/features/computer/logic";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import { withMobileKeys } from "../../src/i18n/merge";

async function translator(lng: "pt-BR" | "en"): Promise<TFunction> {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    fallbackLng: "pt-BR",
    resources: withMobileKeys(resources, { "pt-BR": featureKeysPtBR, en: featureKeysEn }),
    interpolation: { escapeValue: false },
  });
  return i18n.t;
}

/** The phone's own words a Cloud workspace shows where its computer is named. */
const CLOUD_KEYS = [
  "browser.live.unavailable.offlineCloudF",
  "browser.live.unavailable.offlineCloudM",
  "browser.live.closedHelpF",
  "browser.live.closedHelpM",
  "browser.card.computer",
  "outage.titleCloud",
  "outage.a11yCloud",
  "outage.cloudSub",
] as const;

const at = (strings: object, path: string) =>
  path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], strings);

describe("the agent's computer on the phone: its words by edition", () => {
  test("the Cloud's computer isn't answering where self-host's is offline", async () => {
    expect(pageGapKey("offline", "F", true)).toBe("mobile.browser.live.unavailable.offlineCloudF");
    expect(pageGapKey("offline", "M", false)).toBe("mobile.browser.live.unavailable.offlineM");
    expect(pageGapKey("closed", "F", true)).toBe("mobile.browser.live.unavailable.closedF");
    const t = await translator("pt-BR");
    expect(t(pageGapKey("offline", "F", true), { name: "Ada" })).toBe(
      "O computador da Ada não está respondendo agora.",
    );
    expect(t(pageGapKey("offline", "M", false), { name: "Theo" })).toBe("O computador do Theo está offline.");
    const en = await translator("en");
    expect(en(pageGapKey("offline", "F", true), { name: "Ada" })).toBe("Ada's computer isn't answering right now.");
    expect(en(pageGapKey("offline", "F", false), { name: "Ada" })).toBe("Ada's computer is offline.");
  });

  test("a screen request is helped from a laptop: 'a computer' alone would read as the agent's", async () => {
    const t = await translator("pt-BR");
    expect(t("mobile.browser.card.computer", { title: "Entrar no banco" })).toBe(
      "Ajude pelo notebook: Entrar no banco",
    );
    const en = await translator("en");
    expect(en("mobile.browser.card.computer", { title: "Sign in" })).toBe("Help from a laptop: Sign in");
  });

  test("a closed browser keeps its sign-ins and promises no reopening", async () => {
    for (const lng of ["pt-BR", "en"] as const) {
      const t = await translator(lng);
      for (const g of ["F", "M"]) expect(t(`mobile.browser.live.closedHelp${g}`)).not.toMatch(/Abre quando|opens when/);
    }
    expect((await translator("pt-BR"))("mobile.browser.live.closedHelpF")).toBe("Os logins continuam salvos.");
    expect((await translator("en"))("mobile.browser.live.closedHelpM")).toBe("Its sign-ins stay saved.");
  });

  test("the phone's own Cloud words name no off, pairing, cloud or terminal", () => {
    for (const [lng, keys] of [
      ["pt-BR", featureKeysPtBR],
      ["en", featureKeysEn],
    ] as const) {
      expect(CLOUD_KEYS.filter((k) => typeof at(keys, k) !== "string")).toEqual([]);
      const hits = CLOUD_KEYS.flatMap((k) => bannedIn(String(at(keys, k)), CLOUD_BANNED[lng]).map((w) => `${k}: ${w}`));
      expect(hits).toEqual([]);
    }
  });

  test("the profile's section and its row are the web's words, so the phone keeps no key of its own", () => {
    for (const keys of [featureKeysPtBR, featureKeysEn]) {
      expect(at(keys, "browser.profile")).toBeUndefined();
    }
    expect(at(resources["pt-BR"].translation, "agentComputer.button")).toBe("Computador");
    expect(at(resources["pt-BR"].translation, "agentComputer.title")).toBe("Computador {{of}} {{name}}");
  });
});

const NOW = Date.parse("2026-10-24T21:05:00.000Z");
const ACME = { name: "Computador da Acme", online: true, lastSeenAt: "2026-10-24T14:05:00.000Z", paused: null };

/** Desk on the workspace's own computer (the Cloud's), its screen and browser ready, nothing going on. */
const facts = (over: Partial<AgentComputerFacts> = {}): AgentComputerFacts => ({
  edition: "cloud",
  held: false,
  setup: null,
  machine: ACME,
  desktop: { available: true, reason: null },
  browser: true,
  browserGranted: true,
  handoff: null,
  userId: "me",
  working: false,
  ...over,
});

const request = (over: Partial<BrowserHandoff> = {}): BrowserHandoff => ({
  id: "h1",
  agentId: "desk",
  runId: "r1",
  machineId: "m1",
  screen: "browser",
  kind: "ask",
  instructions: "Entrar no gov.br",
  status: "pending",
  requestedForUserId: null,
  controllerUserId: null,
  note: null,
  expiresAt: new Date(NOW + 4 * 60_000).toISOString(),
  createdAt: new Date(NOW - 60_000).toISOString(),
  resolvedAt: null,
  ...over,
});

const external = (patch: Partial<ComputerSetup> = {}): ComputerSetup => ({
  mode: "external",
  state: "preparing",
  step: "installing",
  reason: null,
  since: "2026-10-24T21:00:00.000Z",
  requestedAt: "2026-10-24T21:00:00.000Z",
  expectedReadyAt: null,
  secondsLeft: 330,
  secondsWaited: 300,
  notifyByEmail: true,
  specs: null,
  machineId: null,
  ...patch,
});
const viewOf = (patch: Partial<ComputerSetup> = {}) => setupView(external(patch), NOW) as SetupView;
/** The workspace's computer on its way, the agent without one. */
const waiting = (over: Partial<AgentComputerFacts> = {}) =>
  facts({ setup: viewOf(), machine: null, desktop: null, browser: false, ...over });

describe("the agent's computer full screen on the phone: what its stage shows", () => {
  test("the page where the web shows the screen: on the phone, take control means the browser", () => {
    expect(phoneStage(facts(), false)).toBe("page");
    // A computer without screens (a Mac): the page too.
    expect(phoneStage(facts({ desktop: { available: false, reason: "not_allowed" } }), false)).toBe("page");
    // At work in another app on its screen: the phone says so, and to watch it from a laptop.
    expect(phoneStage(facts({ working: true }), true)).toBe("otherApp");
    // This person in the agent's browser: its page, whatever the agent did on its screen before.
    expect(phoneStage(facts({ handoff: request({ status: "active", controllerUserId: "me" }) }), true)).toBe("page");
    // A screen and no browser: nothing the phone can show.
    expect(phoneStage(facts({ browser: false }), false)).toBe("laptop");
  });

  test("held or on its way first, then why nothing shows, in the web's order", () => {
    expect(phoneStage(waiting(), false)).toBe("preparing");
    expect(phoneStage(waiting({ held: true }), false)).toBe("held");
    expect(phoneStage(facts({ machine: { ...ACME, online: false } }), false)).toBe("offline");
    // Ready, and the agent gets it at its next hello: a moment more.
    expect(phoneStage(facts({ machine: null, desktop: null, browser: false }), false)).toBe("joining");
    expect(phoneStage(facts({ edition: "selfhost", machine: null, desktop: null, browser: false }), false)).toBe(
      "noComputer",
    );
    const neither = { desktop: { available: false, reason: "no_desktop" }, browser: false, browserGranted: false };
    expect(phoneStage(facts(neither), false)).toBe("noScreen");
    expect(phoneStage(facts({ desktop: { available: false, reason: "runner_outdated" }, browser: false }), false)).toBe(
      "unavailable",
    );
  });

  test("the agent's latest step decides whether it works on its screen; the screen's steps in its words", async () => {
    expect(onScreen([{ screen: "browser" }, { screen: "desktop" }])).toBe(true);
    expect(onScreen([{ screen: "desktop" }, { screen: "browser" }])).toBe(false);
    expect(onScreen([])).toBe(false);
    const en = await translator("en");
    expect(stepText(en, { tool: "desktop_click", detail: null }, "desktop")).toBe("Clicked");
    expect(stepText(en, { tool: "mcp__agentes__desktop_open", detail: "Files" }, "desktop")).toBe("Opened Files");
    expect(stepText(en, { tool: "desktop_open", detail: null }, "desktop")).toBe("Opened an app");
    expect(stepText(en, { tool: "desktop_something_new", detail: null }, "desktop")).toBe("Used its screen");
    const pt = await translator("pt-BR");
    expect(pt("agentComputer.phone.otherApp", { name: "Ada", The: "A" })).toBe(
      "A Ada está usando outro app na própria tela",
    );
    expect(pt("agentComputer.phone.fromComputer")).toBe("Para ver a tela, abra o agentes.chat num notebook");
  });
});

describe("the profile's Computador entry on the phone", () => {
  test("Help only for a request in the agent's browser; one on its screen is helped from a laptop", () => {
    const browserAsk = entryState(facts({ handoff: request() }), NOW);
    expect(phoneEntryButton(browserAsk)).toBe("help");
    const screenAsk = entryState(facts({ handoff: request({ screen: "desktop" }) }), NOW);
    expect(screenAsk.kind).toBe("needsYou");
    expect(phoneEntryButton(screenAsk)).toBe("open");
    expect(screenRequest(request({ screen: "desktop" }))?.id).toBe("h1");
    expect(screenRequest(request({ screen: "desktop", status: "done" }))).toBeNull();
    expect(screenRequest(request())).toBeNull();
    // A request for someone else, and no computer (the phone has no picker): Open.
    expect(phoneEntryButton(entryState(facts({ handoff: request({ requestedForUserId: "ana" }) }), NOW))).toBe("open");
    const none = entryState(facts({ edition: "selfhost", machine: null, desktop: null, browser: false }), NOW);
    expect(none.kind).toBe("noComputer");
    expect(phoneEntryButton(none)).toBe("open");
  });

  test("the web's status line, in each edition's words", async () => {
    const t = await translator("pt-BR");
    const words: EntryWords = {
      edition: "cloud",
      locale: "pt-BR",
      computer: "Computador da Acme",
      lastSeenAt: ACME.lastSeenAt,
      person: () => "Ana",
      step: null,
      emailPromised: false,
      now: new Date(NOW),
    };
    const offline = facts({ machine: { ...ACME, online: false } });
    expect(entryLine(t, entryState(offline, NOW), words)).toBe("Sem resposta · já estamos cuidando");
    expect(entryLine(t, entryState({ ...offline, edition: "selfhost" }, NOW), { ...words, edition: "selfhost" })).toBe(
      `Offline desde ${clockAt("pt-BR", ACME.lastSeenAt, new Date(NOW))}`,
    );
    expect(entryLine(t, entryState(waiting(), NOW), words)).toBe("Sendo preparado · faltam uns 6 min");
    expect(entryLine(t, entryState(waiting({ held: true }), NOW), words)).toBe("Em pausa por enquanto");
    expect(entryLine(t, entryState(facts({ handoff: request() }), NOW), words)).toBe(
      "Precisa de você · Entrar no gov.br · 4 min",
    );
    // The phone hears no run here: at work, it says only that.
    expect(entryLine(t, entryState(facts({ working: true }), NOW), words)).toBe("Trabalhando");
  });

  test("no Trocar computador on the Cloud: there is no other computer there", () => {
    expect(offersSwitch({ edition: "cloud" }, true, true)).toBe(false);
    expect(offersSwitch({ edition: "selfhost" }, true, true)).toBe(true);
    // Only for who manages the agents, and only for a computer that went offline with them waiting.
    expect(offersSwitch({ edition: "selfhost" }, false, true)).toBe(false);
    expect(offersSwitch({ edition: "selfhost" }, true, false)).toBe(false);
  });
});

describe("the workspace's computer on its way, on Conversas", () => {
  test("its notice: the time left, else where it is", async () => {
    const t = await translator("pt-BR");
    expect(t("computerSetup.notice.title", { org: "Acme" })).toBe("Preparando o computador da Acme");
    const view = viewOf();
    expect(setupNoticeLine(t, view, setupEta(view, NOW))).toBe("Faltam uns 6 min");
    const slow = viewOf({ state: "waiting", step: null, reason: "capacity", secondsLeft: null });
    expect(setupNoticeLine(t, slow, setupEta(slow, NOW))).toBe("Está demorando mais que o normal. Nada se perde.");
    // On hold no time is said: where it is instead.
    expect(setupNoticeLine(t, view, null)).toBe("Instalando os programas");
  });
});
