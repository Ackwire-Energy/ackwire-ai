/**
 * Pure helpers shared by the app's screens: agent looks, names, grammar,
 * times and the fuse of a request. No React Native, no i18n (screens turn
 * the keys into words).
 */

import { isFeminineName } from "@agenteschat/client/lib/grammar";

export const AGENT_COLORS = ["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];
export const AGENT_EYES = ["round", "dots", "wide", "happy", "sleepy"] as const;
export type AgentEyes = (typeof AGENT_EYES)[number];
export const AGENT_ACCESSORIES = [
  "none",
  "hat",
  "cap",
  "headphones",
  "bow",
  "crown",
  "antenna",
  "headset",
  "beanie",
  "party",
  "flower",
  "scarf",
] as const;
export type AgentAccessory = (typeof AGENT_ACCESSORIES)[number];

export interface AgentLook {
  color: AgentColor;
  eyes: AgentEyes;
  accessory?: AgentAccessory;
}

const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/** The look the engine draws: only known values (the backend's allow-list), else the default agent. */
export function agentLook(agent: { appearance?: unknown } | null | undefined): AgentLook {
  const raw = agent?.appearance;
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const accessory = pick(AGENT_ACCESSORIES, o.accessory);
  return {
    color: pick(AGENT_COLORS, o.color) ?? "sky",
    eyes: pick(AGENT_EYES, o.eyes) ?? "round",
    ...(accessory && accessory !== "none" ? { accessory } : {}),
  };
}

/** Which grammar keys to use with a name (`mobile.grammar.*F` / `*M`), by the web's rule. */
export const genderOf = (name: string): "F" | "M" => (isFeminineName(name) ? "F" : "M");

/** "Ana e Theo", "Ana, Theo e Iris" (`and` is " e " / " and "). */
export function joinNames(names: string[], and: string) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1]}`;
}

/** The letter on a person's avatar. */
export function initialOf(name: string) {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Whole days between the day of `iso` and today (0 = today), in local time. */
export function daysAgo(iso: string, now = new Date()) {
  return Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
}

/** How a time is said in a list: the clock today, "Ontem", the weekday this week, else the date. */
export type WhenKind = "time" | "yesterday" | "weekday" | "date";
export function whenKind(iso: string, now = new Date()): WhenKind {
  const days = daysAgo(iso, now);
  if (days <= 0) return "time";
  if (days === 1) return "yesterday";
  if (days < 7) return "weekday";
  return "date";
}

/** The time `useNow` keeps, and how often its interval reads it. */
export interface PacedClock {
  every: number;
  now: number;
}

/**
 * `useNow`'s clock once asked to move every `every` ms, at `at`. The same pace keeps the time its interval last read, so
 * every draw in between reads the same and a count steps evenly; a new pace reads it afresh, as the time kept can be a
 * whole interval of the old pace old (a minute's, just as a count of seconds starts).
 */
export const pacedClock = (clock: PacedClock, every: number, at: number): PacedClock =>
  clock.every === every ? clock : { every, now: at };

/** Minutes until `iso` (never below 0). */
export function minutesLeft(iso: string, now = Date.now()) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 60_000));
}

/** What is left of a request's time, 0..1 (the fuse). */
export function fuseRemaining(createdAt: string, expiresAt: string, now = Date.now()) {
  const start = new Date(createdAt).getTime();
  const end = new Date(expiresAt).getTime();
  if (!(end > start)) return 0;
  return Math.min(1, Math.max(0, (end - now) / (end - start)));
}

/** "Bom dia", "Boa tarde", "Boa noite" by the hour. */
export function greetingKey(now = new Date()): "morning" | "afternoon" | "evening" {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  return "evening";
}

export { firstName } from "@agenteschat/client/lib/format";

/** Ids that are safe to put in a route. */
export const isSafeId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id);

/** One line of text for previews: no Markdown marks, spaces collapsed. */
export function previewOf(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
