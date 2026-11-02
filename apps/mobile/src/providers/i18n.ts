import type { LocaleState } from "@agenteschat/client/lib/locale-sync";
import { type AppLocale, isAppLocale, LOCALE_CODES } from "@agenteschat/i18n/locale";
import { fillPluralGaps, type LocaleStrings } from "@agenteschat/i18n/plurals";
import { getLocales } from "expo-localization";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { featureKeysEn } from "@/features/i18n/keys.en";
import { featureKeysPtBR } from "@/features/i18n/keys.pt-BR";
import de from "@/features/i18n/locales/de.json";
import es from "@/features/i18n/locales/es.json";
import fr from "@/features/i18n/locales/fr.json";
import id from "@/features/i18n/locales/id.json";
import it from "@/features/i18n/locales/it.json";
import ja from "@/features/i18n/locales/ja.json";
import ko from "@/features/i18n/locales/ko.json";
import nl from "@/features/i18n/locales/nl.json";
import pl from "@/features/i18n/locales/pl.json";
import ru from "@/features/i18n/locales/ru.json";
import tr from "@/features/i18n/locales/tr.json";
import zhHans from "@/features/i18n/locales/zh-Hans.json";
import { DEFAULT_LOCALE, pickLocale, withMobileKeys } from "@/i18n/merge";
import { readValueSync, writeValue } from "@/lib/storage";

/** The screens' strings per language. */
const FEATURES: Record<AppLocale, LocaleStrings> = {
  en: featureKeysEn,
  "pt-BR": featureKeysPtBR,
  es,
  fr,
  de,
  it,
  nl,
  ja,
  ko,
  "zh-Hans": zhHans,
  id,
  tr,
  pl,
  ru,
};

/**
 * The shared strings, required only when the language is used: Metro bundles every file but runs one only on its
 * first `require`, so the phone starts with English and its own language parsed.
 */
const SHARED: Record<AppLocale, () => LocaleStrings> = {
  en: () => require("@agenteschat/i18n/en").en,
  "pt-BR": () => require("@agenteschat/i18n/pt-BR").ptBR,
  es: () => require("@agenteschat/i18n/locales/es.json"),
  fr: () => require("@agenteschat/i18n/locales/fr.json"),
  de: () => require("@agenteschat/i18n/locales/de.json"),
  it: () => require("@agenteschat/i18n/locales/it.json"),
  nl: () => require("@agenteschat/i18n/locales/nl.json"),
  ja: () => require("@agenteschat/i18n/locales/ja.json"),
  ko: () => require("@agenteschat/i18n/locales/ko.json"),
  "zh-Hans": () => require("@agenteschat/i18n/locales/zh-Hans.json"),
  id: () => require("@agenteschat/i18n/locales/id.json"),
  tr: () => require("@agenteschat/i18n/locales/tr.json"),
  pl: () => require("@agenteschat/i18n/locales/pl.json"),
  ru: () => require("@agenteschat/i18n/locales/ru.json"),
};

const bundle = (code: AppLocale) =>
  withMobileKeys({ [code]: { translation: fillPluralGaps(code, SHARED[code]()) } }, { [code]: FEATURES[code] })[code] ??
  {};

/** The phone's language mapped to ours (English when it is none the app speaks). */
export function deviceLocale(): AppLocale {
  try {
    return pickLocale(getLocales().map((l) => l.languageTag));
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** This phone's choice (a code or "auto"), kept through a restart and a sign-out. */
const LOCALE_KEY = "locale";
/** "1" while a choice made signed out waits for the next sign-in to reach the server. */
const PENDING_KEY = "locale-pending";

export function readLocaleState(): LocaleState {
  const stored = readValueSync(LOCALE_KEY);
  return {
    stored: stored === "auto" ? "auto" : isAppLocale(stored) ? stored : null,
    pending: readValueSync(PENDING_KEY) === "1",
  };
}

export function rememberLocale(store: AppLocale | "auto", pending: boolean) {
  void writeValue(LOCALE_KEY, store);
  void writeValue(PENDING_KEY, pending ? "1" : null);
}

function startLocale(): AppLocale {
  const { stored } = readLocaleState();
  return stored && stored !== "auto" ? stored : deviceLocale();
}

/** Shows the app in `code`, parsing its strings the first time. */
export function setLocale(code: AppLocale) {
  if (!i18n.hasResourceBundle(code, "translation")) {
    for (const [ns, strings] of Object.entries(bundle(code))) i18n.addResourceBundle(code, ns, strings);
  }
  void i18n.changeLanguage(code);
}

/** i18next with the shared strings plus the app's `mobile.*` ones; initialized once, synchronously. */
export function setupI18n(): typeof i18n {
  if (i18n.isInitialized) return i18n;
  const lng = startLocale();
  void i18n.use(initReactI18next).init({
    resources: Object.fromEntries([...new Set([lng, DEFAULT_LOCALE])].map((code) => [code, bundle(code)])),
    lng,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: LOCALE_CODES,
    load: "currentOnly",
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return i18n;
}

export { i18n };
