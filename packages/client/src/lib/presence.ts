import type { TFunction } from "i18next";
import type {
  AgentPresence,
  AgentStatus,
  AgentStatusKind,
  AgentStatusLine,
  Availability,
  MemberPresence,
  MemberStatus,
} from "../api/types";
import { clockHour } from "./format";
import { workStatusText } from "./long-work";

/**
 * Presence and written status (ADR 0084), platform-neutral: what you pick, the suggestions, when a status
 * clears, and how an agent's line reads. Web and phone draw it their own way.
 */

/** What a person picks, in the order the apps list them. */
export const AVAILABILITIES: readonly Availability[] = ["auto", "away", "busy", "hidden"];

/** How you appear for what you picked (to yourself: hidden stays hidden). */
export const presenceOfAvailability = (a: Availability): MemberPresence => (a === "auto" ? "online" : a);

/** Any presence a badge draws: people's and agents'. */
export type AnyPresence = MemberPresence | AgentPresence;

export type UntilChoice = "never" | "m30" | "h1" | "h2" | "h4" | "today" | "week";
export const UNTIL_CHOICES: readonly UntilChoice[] = ["never", "m30", "h1", "h2", "h4", "today", "week"];

/** The suggestions under the field: a line, its emoji, when it clears and how you appear. */
export const STATUS_SUGGESTIONS = [
  { key: "meeting", emoji: "📅", until: "h1", availability: "busy" },
  { key: "lunch", emoji: "🍽️", until: "m30", availability: "away" },
  { key: "focus", emoji: "🎧", until: "h2", availability: "busy" },
  { key: "sick", emoji: "🤒", until: "today", availability: "away" },
  { key: "vacation", emoji: "🏖️", until: "week", availability: "away" },
] as const satisfies readonly { key: string; emoji: string; until: UntilChoice; availability: Availability }[];

/** When a status picked with `choice` at `now` clears (ISO), or null; "today"/"week" end at local midnight. */
export function untilFor(choice: UntilChoice, now = new Date()): string | null {
  const plus = (ms: number) => new Date(now.getTime() + ms).toISOString();
  switch (choice) {
    case "never":
      return null;
    case "m30":
      return plus(30 * 60_000);
    case "h1":
      return plus(3600_000);
    case "h2":
      return plus(2 * 3600_000);
    case "h4":
      return plus(4 * 3600_000);
    case "today": {
      const end = new Date(now);
      end.setHours(23, 59, 0, 0);
      return end.toISOString();
    }
    case "week": {
      // Up to Sunday night (the week ends with the weekend).
      const end = new Date(now);
      end.setDate(end.getDate() + ((7 - end.getDay()) % 7));
      end.setHours(23, 59, 0, 0);
      return end.toISOString();
    }
  }
}

/** "Some às 15:00" today, "Some sexta" within the week, else the date; "Até você mudar" without an end. */
export function clearsText(t: TFunction, language: string, until: string | null, now = new Date()): string {
  if (!until) return t("presence.untilChanged");
  const at = new Date(until);
  if (at.toDateString() === now.toDateString()) {
    return t("presence.clearsAt", {
      time: at.toLocaleTimeString(language, { hour: clockHour(language), minute: "2-digit" }),
    });
  }
  const days = (at.getTime() - now.getTime()) / 86_400_000;
  const when =
    days < 7
      ? at.toLocaleDateString(language, { weekday: "long" })
      : at.toLocaleDateString(language, { day: "numeric", month: "short" });
  return t("presence.clearsOn", { when });
}

/** A person's line as one string: "📅 Em reunião". */
export const memberStatusText = (s: MemberStatus) => (s.emoji ? `${s.emoji} ${s.text}` : s.text);

/** The emoji of a line the server picked. */
export const AGENT_KIND_EMOJI: Record<AgentStatusKind, string> = {
  task: "🧩",
  routine: "🔁",
  mission: "🚀",
  channel: "💬",
  browsing: "🌐",
  coding: "💻",
  files: "📁",
  wiki: "📝",
  planning: "🗂️",
  data: "📊",
  mail: "✉️",
  connector: "🔌",
  computer: "🖥️",
  waiting_approval: "⏳",
  waiting_answer: "⏳",
  waiting_computer: "⏳",
  waiting_plan: "⏳",
  waiting_budget: "⏳",
  provider_down: "⚠️",
  work: "🛠️",
};

/** An agent's line in words (its own, or the server's kind worded in the app's language), with its emoji. */
export function agentStatusText(t: TFunction, line: AgentStatusLine): { emoji: string; text: string } | null {
  if (line.text) return { emoji: line.emoji ?? AGENT_KIND_EMOJI.task, text: line.text };
  if (!line.kind) return null;
  if (line.kind === "work") return { emoji: line.emoji ?? AGENT_KIND_EMOJI.work, text: workStatusText(t, line) };
  return {
    emoji: line.emoji ?? AGENT_KIND_EMOJI[line.kind],
    text: t(`presence.agent.${line.kind}`, { subject: line.subject ?? "" }),
  };
}

/** An agent's presence as the apps draw it: no AI to think with reads as offline (ADR 0084 §3). */
export const agentPresenceShown = (status: AgentStatus | undefined, hasAi: boolean): AgentPresence =>
  !hasAi ? "offline" : (status?.presence ?? "away");
