import { resources as shared } from "@agenteschat/i18n";
import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";
import type { Platform } from "../control/platform";
import { desktopEn } from "./keys.en";
import { type DesktopTranslations, desktopPtBR } from "./keys.pt-BR";

/** pt-BR is the default, English the alternative (same as the web and the phone). */
export type AppLocale = "pt-BR" | "en";
export const DEFAULT_LOCALE: AppLocale = "pt-BR";

export const DESKTOP_STRINGS: Record<AppLocale, object> = { "pt-BR": desktopPtBR, en: desktopEn };

/**
 * The shared resources (locale → namespace → strings) with the app's own strings under `desktop`
 * in every namespace, so `t("desktop.tray.now")` works next to the shared keys.
 */
export function withDesktopKeys(resources: Record<string, Record<string, object>>) {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [locale, namespaces] of Object.entries(resources)) {
    const desktop = DESKTOP_STRINGS[locale as AppLocale] ?? desktopPtBR;
    const merged: Record<string, Record<string, unknown>> = {};
    for (const [ns, strings] of Object.entries(namespaces)) merged[ns] = { ...(strings as object), desktop };
    out[locale] = merged;
  }
  return out;
}

/** The Mac's languages (most preferred first) mapped to ours: "pt-PT" → pt-BR, "en-GB" → en, else pt-BR. */
export function pickLocale(tags: readonly (string | null | undefined)[]): AppLocale {
  for (const tag of tags) {
    const t = (tag ?? "").toLowerCase();
    if (t.startsWith("pt")) return "pt-BR";
    if (t.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}

export function systemLocale(): AppLocale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  return pickLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** This computer's name in `lng` ("Mac", "PC", "computador"). */
export const deviceName = (lng: AppLocale, platform: Platform) =>
  (DESKTOP_STRINGS[lng] as DesktopTranslations).device[platform];

/** `{{device}}` is filled in for every string, so callers never pass it. */
export function createDesktopI18n(lng: AppLocale = systemLocale(), platform: Platform = "mac"): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources: withDesktopKeys(shared),
    lng,
    fallbackLng: DEFAULT_LOCALE,
    interpolation: { escapeValue: false, defaultVariables: { device: deviceName(lng, platform) } },
    initAsync: false,
    returnNull: false,
  });
  return instance;
}
