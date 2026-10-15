import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { BuiltinArea } from "@/lib/access";

/** Translated names of the built-in tool areas ("Issues", "Agenda", "Contexto e memória"…). */
export function useAreaLabel() {
  const { t } = useTranslation();
  return useCallback((area: BuiltinArea) => t(`access.area.${area}`), [t]);
}
