/** A plain reminder the agent posted (`meta.reminder`): shown as the agent's message with a "Lembrete" label. */
export const isReminderMessage = (meta: Record<string, unknown> | undefined) => meta?.reminder === true;

/**
 * A message a routine posted (`meta.routine`): shown as the routine's, not as
 * its creator's. Plain reminders are the agent's own messages, so not here.
 */
export function routineOfMessage(meta: Record<string, unknown> | undefined): { id: string; name: string } | null {
  if (isReminderMessage(meta)) return null;
  const r = meta?.routine as { id?: unknown; name?: unknown } | undefined;
  return r && typeof r.id === "string" && typeof r.name === "string" ? { id: r.id, name: r.name } : null;
}

/** Zones people pick most often; the select also keeps whatever zone a routine already has. */
export const COMMON_TIMEZONES = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Fortaleza",
  "America/Recife",
  "America/Belem",
  "America/Cuiaba",
  "America/Rio_Branco",
  "America/Noronha",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Madrid",
  "UTC",
];

const NAMES: Record<string, string> = {
  "America/Sao_Paulo": "horário de Brasília",
  "America/Manaus": "horário do Amazonas",
  "America/Fortaleza": "horário de Fortaleza",
  "America/Recife": "horário de Recife",
  "America/Belem": "horário de Belém",
  "America/Cuiaba": "horário de Cuiabá",
  "America/Rio_Branco": "horário do Acre",
  "America/Noronha": "horário de Fernando de Noronha",
  "America/New_York": "Nova York",
  "America/Chicago": "Chicago",
  "America/Los_Angeles": "Los Angeles",
  "Europe/Lisbon": "Lisboa",
  "Europe/London": "Londres",
  "Europe/Madrid": "Madri",
};

/** "UTC−3", "UTC+5:30", "UTC" for a zone at `at`. */
export function utcOffset(timeZone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? "");
    if (!m) return "UTC";
    const hours = String(Number(m[2]));
    return `UTC${m[1] === "-" ? "−" : "+"}${hours}${m[3] === "00" ? "" : `:${m[3]}`}`;
  } catch {
    return "UTC";
  }
}

/** "horário de Brasília (UTC−3)"; "UTC"; unknown zones by their IANA name with the offset. */
export function timezoneLabel(timeZone: string, at = new Date()): string {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  return `${NAMES[timeZone] ?? timeZone} (${utcOffset(timeZone, at)})`;
}

/** The browser's zone, if it has one. */
export function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "horário de Brasília" (the zone's name, without the offset). */
export const timezoneName = (timeZone: string) =>
  timeZone === "UTC" || timeZone === "Etc/UTC" ? "UTC" : (NAMES[timeZone] ?? timeZone);

/** A one-off's moment in its own zone: { weekday: "qui", date: "16/10", time: "09:00", zone: "horário de Brasília" }. */
export function onceParts(locale: string, at: string, timeZone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).formatToParts(new Date(at));
  } catch {
    parts = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: get("weekday").replace(/\.$/, ""),
    date: `${get("day")}/${get("month")}`,
    time: `${get("hour")}:${get("minute")}`,
    zone: timezoneName(timeZone),
  };
}
