import type { AppLocale } from "@agenteschat/i18n/locale";
import { Select } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { autoLabel, chooseLocale, locales, readLocaleState } from "@/i18n";

/**
 * The language picker: "Automatic (the browser's language)" first, then each language by its own name. A pick
 * applies at once and stays on this browser; `onPick` tells the server when signed in.
 */
export function LanguageSelect({
  signedIn,
  onPick,
  id,
  size = "sm",
  align,
}: {
  signedIn: boolean;
  onPick?: (choice: AppLocale | "auto") => void;
  id?: string;
  size?: "sm" | "md";
  align?: "start" | "end";
}) {
  const { t, i18n } = useTranslation();
  const [choice, setChoice] = useState<AppLocale | "auto">(() => readLocaleState().stored ?? "auto");
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
      options={[
        { value: "auto" as const, label: autoLabel(t) },
        ...locales.map((l) => ({ value: l.code, label: l.label })),
      ]}
    />
  );
}
