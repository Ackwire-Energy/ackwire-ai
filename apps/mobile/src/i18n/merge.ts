import { type AppLocale, appLocale } from "@agenteschat/i18n/locale";
import { mobileEn } from "./keys.en";
import { mobilePtBR } from "./keys.pt-BR";

export type { AppLocale };
/** The app's locales: pt-BR is the default, English the alternative (same as the web). */
export const DEFAULT_LOCALE: AppLocale = "pt-BR";

const MOBILE: Record<AppLocale, object> = { "pt-BR": mobilePtBR, en: mobileEn };

type Strings = Record<string, unknown>;
type Resources = Record<string, Record<string, Strings>>;

/** Deep merge of string trees: `b` wins on the same leaf, nested objects merge. */
export function deepMerge(a: object, b: object): Strings {
  const out: Strings = { ...(a as Strings) };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] =
      v && typeof v === "object" && prev && typeof prev === "object" ? deepMerge(prev as object, v as object) : v;
  }
  return out;
}

/**
 * The shared resources (`@agenteschat/i18n`, i18next shape: locale -> namespace -> strings) with the app's
 * own strings added under `mobile` in every namespace, so `t("mobile.auth.social.failed")` works with
 * whatever namespace the shared package uses. `extra` adds more `mobile.*` strings per locale (the
 * screens' keys); a locale without them falls back to pt-BR through i18next's `fallbackLng`.
 */
export function withMobileKeys(
  resources: Record<string, Record<string, object>>,
  extra: Partial<Record<AppLocale, object>> = {},
): Resources {
  const out: Resources = {};
  for (const [locale, namespaces] of Object.entries(resources)) {
    const own = MOBILE[locale as AppLocale] ?? mobilePtBR;
    const more = extra[locale as AppLocale];
    const mobile = more ? deepMerge(own, more) : own;
    const merged: Record<string, Strings> = {};
    for (const [ns, strings] of Object.entries(namespaces)) merged[ns] = { ...(strings as Strings), mobile };
    out[locale] = merged;
  }
  return out;
}

/** The phone's languages (most preferred first) mapped to ours: "pt-PT" → pt-BR, "en-GB" → en, else pt-BR. */
export function pickLocale(tags: readonly (string | null | undefined)[]): AppLocale {
  return appLocale(tags) ?? DEFAULT_LOCALE;
}
