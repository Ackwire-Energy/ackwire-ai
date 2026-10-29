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
 * The routine an agent's message answers (ADR 0053 §7): the run a routine's report woke tells people in
 * the agent's voice, and its message carries `meta.routine` (`id`, `name`, the routine run `runId`, the
 * `noticeId` of the report it answers). Shown as a small tag ("Rotina «X»") that opens the routine and
 * unfolds the report. A plain reminder is the agent's own message, so not here.
 */
export interface RoutineReply {
  id: string;
  name: string;
  /** The routine run (`routine_runs.id`). */
  runId: string | null;
  /** The `routine_handoff` notice it answers (hidden in the timeline while this answer is there). */
  noticeId: string | null;
}

export function routineReplyOf(m: { author: { type: string }; meta?: Record<string, unknown> }): RoutineReply | null {
  if (m.author.type !== "agent" || isReminderMessage(m.meta)) return null;
  const r = m.meta?.routine as Record<string, unknown> | undefined;
  if (!r || typeof r.id !== "string" || typeof r.name !== "string") return null;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { id: r.id, name: r.name, runId: text(r.runId) ?? text(r.routineRunId), noticeId: text(r.noticeId) };
}

/**
 * A person's message carrying `meta.routine`: a routine's call or firing written as its creator (before
 * routines fired in their own room, ADR 0053 §4). Never shown: it isn't something the person said.
 */
export const isRoutineCall = (m: { author: { type: string }; meta?: Record<string, unknown> }) => {
  const r = m.meta?.routine as { id?: unknown } | undefined;
  return m.author.type === "person" && typeof r?.id === "string";
};

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

/** English names (the Portuguese ones below are the default), one for every zone named there. */
const NAMES_EN: Record<keyof typeof NAMES, string> = {
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
  "America/Toronto": "Toronto",
  "America/Mexico_City": "Mexico City",
  "America/Argentina/Buenos_Aires": "Buenos Aires",
  "America/Santiago": "Santiago",
  "America/Bogota": "Bogotá",
  "America/Lima": "Lima",
  "America/Montevideo": "Montevideo",
  "America/Asuncion": "Asunción",
  "Europe/Lisbon": "Lisbon",
  "Europe/London": "London",
  "Europe/Madrid": "Madrid",
  "Europe/Paris": "Paris",
  "Europe/Berlin": "Berlin",
  "Europe/Rome": "Rome",
  "Europe/Amsterdam": "Amsterdam",
  "Atlantic/Azores": "Azores",
  "Africa/Luanda": "Luanda",
  "Africa/Maputo": "Maputo",
  "Asia/Dubai": "Dubai",
  "Asia/Kolkata": "India",
  "Asia/Singapore": "Singapore",
  "Asia/Shanghai": "Shanghai (China)",
  "Asia/Tokyo": "Tokyo",
  "Australia/Sydney": "Sydney",
  "Pacific/Auckland": "Auckland",
};
const namesFor = (locale?: string): Partial<Record<string, string>> =>
  locale && !locale.startsWith("pt") ? NAMES_EN : NAMES;

const NAMES = {
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
} satisfies Record<string, string>;

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
  return `${namesFor(locale)[timeZone] ?? timeZone} (${utcOffset(timeZone, at)})`;
}

/** The browser's zone, if it has one. */
export function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * "horário de Brasília" (the zone's name, without the offset). A zone we don't name goes by the platform's name in
 * `locale` ("Horário da Europa Central"): its IANA id only where the platform has no name for it.
 */
export const timezoneName = (timeZone: string, locale?: string) =>
  timeZone === "UTC" || timeZone === "Etc/UTC"
    ? "UTC"
    : (namesFor(locale)[timeZone] ?? platformZoneName(timeZone, locale) ?? timeZone);

/**
 * The platform's name for a zone in `locale` ("Horário do Nepal"). Never a bare offset ("GMT-03:00", what an engine
 * without zone names gives a city's zone), except for a zone that is only an offset ("Etc/GMT+3").
 */
export function platformZoneName(timeZone: string, locale?: string): string | undefined {
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return name && (timeZone.startsWith("Etc/") || !/^(GMT|UTC)/.test(name)) ? name : undefined;
  } catch {
    return undefined;
  }
}

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
  const name = namesFor(locale)[timeZone];
  return name ? name.charAt(0).toLocaleUpperCase() + name.slice(1) : undefined;
}
