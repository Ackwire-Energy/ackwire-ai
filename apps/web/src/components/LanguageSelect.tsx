import type { AppLocale } from "@agenteschat/i18n/locale";
import { Select } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { chooseLocale, detectedLocale, locales, readLocaleState } from "@/i18n";

/**
 * The language picker: each language by its own name, the one in use chosen. Someone who never picked sees the
 * browser's language chosen and keeps following it (ADR 0122); a pick applies at once and stays on this browser;
 * `onPick` tells the server when signed in.
 */
export function LanguageSelect({
  signedIn,
  onPick,
  id,
  size = "sm",
  align,
}: {
  signedIn: boolean;
  onPick?: (choice: AppLocale) => void;
  id?: string;
  size?: "sm" | "md";
  align?: "start" | "end";
}) {
  const { t, i18n } = useTranslation();
  const [choice, setChoice] = useState<AppLocale>(() => {
    const { stored } = readLocaleState();
    return stored && stored !== "auto" ? stored : detectedLocale();
  });
  return (
    <Select
      id={id}
      size={size}
      align={align}
      aria-label={t("shell.language")}
      value={choice}
      onValueChange={(v) => {
        setChoice(v);
        chooseLocale(v, i18n, signedIn);
        onPick?.(v);
      }}
      options={locales.map((l) => ({ value: l.code, label: l.label }))}
    />
  );
}
