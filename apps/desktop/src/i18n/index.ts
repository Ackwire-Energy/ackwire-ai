import { resources as shared } from "@agenteschat/i18n";
import {
  type AppLocale,
  appLocale,
  DEFAULT_LOCALE,
  isAppLocale,
  LOCALE_CODES,
  readyLocales,
} from "@agenteschat/i18n/locale";
import { fillPluralGaps, type LocaleStrings } from "@agenteschat/i18n/plurals";
import { deepMerge } from "@agenteschat/i18n/tree";
import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";
import type { Platform } from "../control/platform";
import { type DesktopTranslations, desktopEn } from "./keys.en";
import { desktopPtBR } from "./keys.pt-BR";
import de from "./locales/de.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import id from "./locales/id.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import nl from "./locales/nl.json";
import pl from "./locales/pl.json";
import ru from "./locales/ru.json";
import tr from "./locales/tr.json";
import zhHans from "./locales/zh-Hans.json";

export type { AppLocale };
export { DEFAULT_LOCALE };

// ponytail: every language is in the bundle (the windows start synchronously); load them like the web's
// `loadStrings` if the app's size starts to matter.
export const DESKTOP_STRINGS: Record<AppLocale, LocaleStrings> = {
  en: desktopEn,
  "pt-BR": desktopPtBR,
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

/** A language's desktop strings with English under every key it lacks (the cover page reads them without i18next). */
export const desktopStrings = (lng: AppLocale): DesktopTranslations => deepMerge(desktopEn, DESKTOP_STRINGS[lng]);

/**
 * The shared resources (locale → namespace → strings) with the app's own strings under `desktop`
 * in every namespace, so `t("desktop.tray.now")` works next to the shared keys.
 */
export function withDesktopKeys(resources: Record<string, Record<string, object>>) {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [locale, namespaces] of Object.entries(resources)) {
    const desktop = isAppLocale(locale) ? fillPluralGaps(locale, DESKTOP_STRINGS[locale]) : {};
    const merged: Record<string, Record<string, unknown>> = {};
    for (const [ns, strings] of Object.entries(namespaces)) merged[ns] = { ...(strings as object), desktop };
    out[locale] = merged;
  }
  return out;
}

/** This computer's choice in Preferences (`agentes.desktop.locale`, shared by every window): a code or "auto". */
export const LOCALE_PREF = "locale";

/** The languages people can pick, each by its own name. */
export const locales = readyLocales().map((l) => ({ code: l.code, label: l.native }));

/** The system's languages (most preferred first) mapped to ours: "pt-PT" → pt-BR, "en-GB" → en, else English. */
export function pickLocale(tags: readonly (string | null | undefined)[]): AppLocale {
  return appLocale(tags) ?? DEFAULT_LOCALE;
}

export function detectedLocale(): AppLocale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  return pickLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** The language picked in Preferences, else the system's. */
export function systemLocale(): AppLocale {
  try {
    const raw = localStorage.getItem(`agentes.desktop.${LOCALE_PREF}`);
    const choice = raw ? JSON.parse(raw) : null;
    if (isAppLocale(choice)) return choice;
  } catch {
    // No storage: the system's language.
  }
  return detectedLocale();
}

/** This computer's name in `lng` ("Mac", "PC", "computador"). */
export const deviceName = (lng: AppLocale, platform: Platform) => desktopStrings(lng).device[platform];

/** `{{device}}` is filled in for every string, so callers never pass it. */
export function createDesktopI18n(lng: AppLocale = systemLocale(), platform: Platform = "mac"): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources: withDesktopKeys(shared),
    lng,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: LOCALE_CODES,
    load: "currentOnly",
    interpolation: { escapeValue: false, defaultVariables: { device: deviceName(lng, platform) } },
    initAsync: false,
    returnNull: false,
  });
  return instance;
}

/** Shows `instance` in `lng`, with `{{device}}` in that language's words. */
export function switchDesktopLocale(instance: I18n, lng: AppLocale, platform: Platform) {
  const interpolation = instance.options.interpolation;
  if (interpolation) interpolation.defaultVariables = { device: deviceName(lng, platform) };
  void instance.changeLanguage(lng);
  document.documentElement.lang = lng;
}
