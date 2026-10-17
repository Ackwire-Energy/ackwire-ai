import { resources } from "@agenteschat/i18n";
import { getLocales } from "expo-localization";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { featureKeysEn } from "@/features/i18n/keys.en";
import { featureKeysPtBR } from "@/features/i18n/keys.pt-BR";
import { type AppLocale, DEFAULT_LOCALE, pickLocale, withMobileKeys } from "@/i18n/merge";

/** The phone's language mapped to ours (pt-BR default, en). */
export function deviceLocale(): AppLocale {
  try {
    return pickLocale(getLocales().map((l) => l.languageTag));
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** i18next with the shared resources plus the app's `mobile.*` strings; initialized once, synchronously. */
export function setupI18n(): typeof i18n {
  if (i18n.isInitialized) return i18n;
  void i18n.use(initReactI18next).init({
    // Plus the screens' strings (src/features/i18n).
    resources: withMobileKeys(resources, { "pt-BR": featureKeysPtBR, en: featureKeysEn }),
    lng: deviceLocale(),
    fallbackLng: DEFAULT_LOCALE,
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return i18n;
}

export { i18n };
