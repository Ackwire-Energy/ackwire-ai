import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { bannedIn, CLOUD_BANNED } from "../../../../packages/i18n/test/edition-words";
import { pageGapKey } from "../../src/features/browser/logic";
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

  test("the profile's section is the shared title, so the phone keeps no key of its own", () => {
    expect(at(featureKeysPtBR, "browser.profile.title")).toBeUndefined();
    expect(at(featureKeysEn, "browser.profile.title")).toBeUndefined();
    expect(at(resources["pt-BR"].translation, "agentComputer.title")).toBe("Computador {{of}} {{name}}");
  });
});
