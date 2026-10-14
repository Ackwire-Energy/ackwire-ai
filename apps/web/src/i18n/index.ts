import i18n, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { ptBR } from "./locales/pt-BR";

/** pt-BR is the primary locale and the default; English is the alternative. */
export const locales = [
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "en", label: "English" },
] as const;
export type LocaleCode = (typeof locales)[number]["code"];
export const DEFAULT_LOCALE: LocaleCode = "pt-BR";

const STORAGE_KEY = "agentes.locale";

export function savedLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && locales.some((l) => l.code === saved)) return saved as LocaleCode;
  } catch {
    // Storage unavailable (private mode): use the default.
  }
  return DEFAULT_LOCALE;
}

export function setLocale(code: LocaleCode, instance: I18n = i18n) {
  void instance.changeLanguage(code);
  if (typeof document !== "undefined") document.documentElement.lang = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Not persisted; still applies to this tab.
  }
}

/** Creates and initializes an i18next instance (one for the app, fresh ones in tests). */
export function createI18n(lng: LocaleCode = DEFAULT_LOCALE): I18n {
  const instance = i18n.createInstance();
  void instance.use(initReactI18next).init({
    resources: { "pt-BR": { translation: ptBR }, en: { translation: en } },
    lng,
    fallbackLng: DEFAULT_LOCALE,
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  });
  return instance;
}
