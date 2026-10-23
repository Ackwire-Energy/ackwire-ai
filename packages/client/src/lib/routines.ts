/** A plain reminder the agent posted (`meta.reminder`): shown as the agent's message with a "Reminder" label. */
export const isReminderMessage = (meta: Record<string, unknown> | undefined) => meta?.reminder === true;

/**
 * A reminder's text without the server's own prefix ("@ana Reminder: …"; older
 * messages say "Lembrete: …"), since the app shows its translated label.
 */
export function reminderBody(body: string, meta: Record<string, unknown> | undefined): string {
  if (!isReminderMessage(meta)) return body;
  return body.replace(/^((?:@[\w.-]+\s+)*)(?:Reminder|Lembrete): /, "$1");
}

/**
 * A message a routine posted (`meta.routine`): shown as the routine's, not as
 * its creator's. Plain reminders are the agent's own messages, so not here.
 */
export function routineOfMessage(meta: Record<string, unknown> | undefined): { id: string; name: string } | null {
  if (isReminderMessage(meta)) return null;
  const r = meta?.routine as { id?: unknown; name?: unknown } | undefined;
  return r && typeof r.id === "string" && typeof r.name === "string" ? { id: r.id, name: r.name } : null;
}

/** The routine an agent's message answers (`meta.viaRoutine`), shown as a small tag next to its name. */
export function viaRoutineOf(meta: Record<string, unknown> | undefined): { id: string; name: string } | null {
  const r = meta?.viaRoutine as { id?: unknown; name?: unknown } | undefined;
  return r && typeof r.id === "string" && typeof r.name === "string" ? { id: r.id, name: r.name } : null;
}

/**
 * The message a routine posts on its creator's behalf to call its agent
 * (top level): hidden from the timeline, only the agent's answer shows. A
 * background routine's start (`meta.background`) stays, as one line: its
 * report comes later, maybe elsewhere (`backgroundRoutineOf` in lib/notices).
 */
export const isRoutineCall = (m: {
  threadId: string | null;
  author: { type: string };
  meta?: Record<string, unknown>;
}) =>
  m.threadId === null && m.author.type === "person" && m.meta?.background !== true && routineOfMessage(m.meta) !== null;

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

/** English names (the Portuguese ones below are the default). */
const NAMES_EN: Record<string, string> = {
  "America/Sao_Paulo": "Brasília time",
  "America/Manaus": "Amazonas time",
  "America/Fortaleza": "Fortaleza time",
  "America/Recife": "Recife time",
  "America/Belem": "Belém time",
  "America/Cuiaba": "Cuiabá time",
  "America/Rio_Branco": "Acre time",
  "America/Noronha": "Fernando de Noronha time",
  "America/New_York": "New York (US Eastern)",
  "America/Chicago": "Chicago (US Central)",
  "America/Denver": "Denver (US Mountain)",
  "America/Los_Angeles": "Los Angeles (US Pacific)",
  "America/Mexico_City": "Mexico City",
  "America/Montevideo": "Montevideo",
  "America/Asuncion": "Asunción",
  "Europe/Lisbon": "Lisbon",
  "Europe/London": "London",
  "Europe/Madrid": "Madrid",
  "Europe/Berlin": "Berlin",
  "Europe/Rome": "Rome",
  "Europe/Amsterdam": "Amsterdam",
  "Atlantic/Azores": "Azores",
  "Asia/Kolkata": "India",
  "Asia/Shanghai": "Shanghai (China)",
  "Asia/Tokyo": "Tokyo",
};
const namesFor = (locale?: string) => (locale && !locale.startsWith("pt") ? NAMES_EN : NAMES);

const NAMES: Record<string, string> = {
  "America/Sao_Paulo": "horário de Brasília",
  "America/Manaus": "horário do Amazonas",
  "America/Fortaleza": "horário de Fortaleza",
  "America/Recife": "horário de Recife",
  "America/Belem": "horário de Belém",
  "America/Cuiaba": "horário de Cuiabá",
  "America/Rio_Branco": "horário do Acre",
  "America/Noronha": "horário de Fernando de Noronha",
  "America/New_York": "Nova York (Leste dos EUA)",
  "America/Chicago": "Chicago (Centro dos EUA)",
  "America/Denver": "Denver (Montanhas dos EUA)",
  "America/Los_Angeles": "Los Angeles (Pacífico dos EUA)",
  "America/Toronto": "Toronto",
  "America/Mexico_City": "Cidade do México",
  "America/Argentina/Buenos_Aires": "Buenos Aires",
  "America/Santiago": "Santiago",
  "America/Bogota": "Bogotá",
  "America/Lima": "Lima",
  "America/Montevideo": "Montevidéu",
  "America/Asuncion": "Assunção",
  "Europe/Lisbon": "Lisboa",
  "Europe/London": "Londres",
  "Europe/Madrid": "Madri",
  "Europe/Paris": "Paris",
  "Europe/Berlin": "Berlim",
  "Europe/Rome": "Roma",
  "Europe/Amsterdam": "Amsterdã",
  "Atlantic/Azores": "Açores",
  "Africa/Luanda": "Luanda",
  "Africa/Maputo": "Maputo",
  "Asia/Dubai": "Dubai",
  "Asia/Kolkata": "Índia",
  "Asia/Singapore": "Singapura",
  "Asia/Shanghai": "Xangai (China)",
  "Asia/Tokyo": "Tóquio",
  "Australia/Sydney": "Sydney",
  "Pacific/Auckland": "Auckland",
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
export function timezoneLabel(timeZone: string, at = new Date(), locale?: string): string {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  const names = namesFor(locale);
  return `${names[timeZone] ?? NAMES[timeZone] ?? timeZone} (${utcOffset(timeZone, at)})`;
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
export const timezoneName = (timeZone: string, locale?: string) =>
  timeZone === "UTC" || timeZone === "Etc/UTC" ? "UTC" : (namesFor(locale)[timeZone] ?? NAMES[timeZone] ?? timeZone);

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
  // Day/month order and 12h/24h follow the locale.
  const fmt = (opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(new Date(at));
    } catch {
      return new Intl.DateTimeFormat(locale, opts).format(new Date(at));
    }
  };
  return {
    weekday: get("weekday").replace(/\.$/, ""),
    date: fmt({ day: "2-digit", month: "2-digit" }),
    time: fmt({ hour: "2-digit", minute: "2-digit" }),
    zone: timezoneName(timeZone, locale),
  };
}

/** The selector's name for a zone: "Horário de Brasília", "Nova York (Leste dos EUA)", "UTC". */
export function zoneDisplayName(timeZone: string, locale?: string): string | undefined {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  const name = namesFor(locale)[timeZone] ?? NAMES[timeZone];
  return name ? name.charAt(0).toLocaleUpperCase() + name.slice(1) : undefined;
}
