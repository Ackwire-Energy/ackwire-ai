import { isAppLocale, localeInfo } from "@agenteschat/i18n/locale";
import { useTranslation } from "react-i18next";
import { router } from "@/ui/navigation";
import { AuthLink } from "./AuthLink";

/** "Idioma · Português (Brasil)": the language before signing in, picked on its own page (ADR 0122). */
export function LanguageLine() {
  const { t, i18n } = useTranslation();
  const label = isAppLocale(i18n.language) ? localeInfo(i18n.language).native : i18n.language;
  return <AuthLink lead={t("shell.language")} label={label} onPress={() => router.push("/language")} />;
}
