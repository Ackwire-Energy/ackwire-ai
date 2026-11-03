import { knownErrorText } from "@agenteschat/client/lib/errors";
import { platformZoneName } from "@agenteschat/client/lib/routines";
import type { TFunction } from "i18next";

/**
 * The phone's first run: the workspace's name, asked by its right hand, then its DM (ADR 0134). Pure: no React
 * Native imports.
 */

/** A save that failed: what the server's code says (a refused workspace, a restriction), else that it didn't save. */
export const stepFailedText = (t: TFunction, error: unknown, locale?: string) =>
  knownErrorText(t, error, locale) ?? t("mobile.onb.failed");

/** The phone's time zone ("America/Sao_Paulo"), or null. */
export function phoneTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "America/Sao_Paulo" → "Sao Paulo": the city, readable. */
export function zoneCity(zone: string): string {
  const city = zone.split("/").pop() ?? zone;
  return city.replace(/_/g, " ");
}

/**
 * The time zone as people read it, in their language ("Horário Padrão de Brasília"); its city ("Sao Paulo", from the
 * id, without accents) where the platform has no name for it, or only an offset ("GMT-03:00").
 */
export function zoneLabel(zone: string, locale: string): string {
  return platformZoneName(zone, locale) ?? zoneCity(zone);
}
