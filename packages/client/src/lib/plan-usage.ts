import type { TFunction } from "i18next";
import type { AgentUsageSource, PlanAccountInfo, PlanAccountUsage, PlanUsage, PlanWindowParts } from "../api/types";
import { ownSignInName } from "./ai-accounts";
import { daysBetween, formatPercent, formatShortDate, formatTime, relativeTime } from "./format";
import { planOf } from "./plans";

/**
 * The words of the plan usage views (ADR 0063), shared by the web and the phone: a plan meter's text, an
 * account's windows with whose use they are, and where an agent's tokens went. Pure, no React.
 */

/** A meter window as `PlanMeter` draws it (the web's and the phone's). */
export interface MeterWindow {
  kind: string;
  label?: string;
  usedPercent: number;
  resetsAt?: string;
  part?: number;
  note?: string;
}

const WINDOW_NAMES = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "monthly"] as const;

/** When a window resets, in the viewer's time zone: the time today, the weekday this week, else the date. */
function resetWhen(locale: string, iso: string, now: Date): { day: string | null; time: string } {
  const time = formatTime(locale, iso);
  const ahead = -daysBetween(iso, now);
  if (ahead <= 0) return { day: null, time };
  const day =
    ahead < 7
      ? new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(iso)).replace(/\.$/, "")
      : formatShortDate(locale, iso);
  return { day, time };
}

/** What `PlanMeter` says, in the viewer's language. */
export function planMeterText(
  t: TFunction,
  locale: string,
  now = new Date(),
): {
  window(w: Pick<MeterWindow, "kind" | "label">): string;
  resets(iso: string): string;
  almost: string;
  limited(until: string | null): string;
  updated(iso: string): string;
} {
  return {
    window: (w) => {
      const kind = WINDOW_NAMES.find((k) => k === w.kind);
      return kind ? t(`aiAccounts.usage.window.${kind}`) : (w.label ?? t("aiAccounts.usage.window.other"));
    },
    resets: (iso) => {
      const { day, time } = resetWhen(locale, iso, now);
      return day ? t("aiAccounts.usage.resetsOn", { day, time }) : t("aiAccounts.usage.resetsAt", { time });
    },
    almost: t("aiAccounts.usage.almost"),
    limited: (until) => {
      if (!until) return t("aiAccounts.usage.limited");
      const { day, time } = resetWhen(locale, until, now);
      return t("aiAccounts.usage.limitedUntil", { when: day ? `${day} ${time}` : time });
    },
    updated: (iso) => t("aiAccounts.usage.updated", { ago: relativeTime(t, locale, iso, now) }),
  };
}

/**
 * An account's windows for `PlanMeter` with whose use they are (the usage views): `note` says each
 * window's parts in words; `focus` draws that agent's part in full ink (none where it has no estimate).
 */
export function partedUsage(
  usage: Omit<PlanUsage, "windows"> & { windows: PlanWindowParts[] },
  note: (parts: NonNullable<PlanWindowParts["agents"]>) => string | undefined,
  focus?: string,
): Omit<PlanUsage, "windows"> & { windows: MeterWindow[] } {
  return {
    ...usage,
    windows: usage.windows.map(({ agents, ...w }) => ({
      ...w,
      ...(agents && agents.length > 0 ? { note: note(agents) } : {}),
      ...(agents && focus ? { part: agents.find((a) => a.agentId === focus)?.percent ?? 0 } : {}),
    })),
  };
}

/** What people call a plan account: its label, or the computer's own sign-in's name (`ownSignInName`). */
export const accountName = (t: TFunction, a: Pick<PlanAccountInfo, "label" | "machineName" | "mine">) =>
  a.label ?? ownSignInName(t, a.mine, a.machineName);

/** Who makes what an account thinks with: a coding plan's maker, else Claude Code or Codex. */
export const brandOf = (a: Pick<PlanAccountInfo, "kind" | "provider">) =>
  planOf(a.provider)?.maker ?? (a.kind === "codex" ? "Codex" : "Claude Code");

/** Why an account shows no windows: its maker doesn't tell them here, nobody used it yet, or nobody uses it. */
export function noWindowsText(t: TFunction, account: Pick<PlanAccountUsage, "provider" | "agents">) {
  const plan = planOf(account.provider);
  if (plan && !plan.usage) return t("aiAccounts.usage.notShared", { maker: plan.maker });
  return account.agents.length ? t("usageViews.noWindows") : t("usageViews.unused");
}

/** Where an agent's tokens went, by name: the account, "API", a removed account or the plan before accounts were recorded. */
export function usageSourceName(t: TFunction, s: AgentUsageSource) {
  if (s.type === "api") return t("usageViews.agent.api");
  if (s.account) return accountName(t, s.account);
  if (s.removed) return t("usageViews.agent.removed");
  return t("usageViews.agent.old", { brand: brandOf({ kind: s.kind ?? "claude_code", provider: null }) });
}

/** A source's share of the agent's month in a sentence: "97% na conta que os seus agentes dividem", "3% pela API". */
export function usageSourcePart(t: TFunction, locale: string, s: AgentUsageSource) {
  const percent = formatPercent(locale, s.share);
  if (s.type === "api") return t("usageViews.agent.apiPart", { percent });
  if (s.account?.accountId === null) {
    return s.account.mine
      ? t("usageViews.agent.sharedPart", { percent })
      : t("usageViews.agent.computerPart", { percent, computer: s.account.machineName });
  }
  if (s.account) return t("usageViews.agent.accountPart", { percent, account: accountName(t, s.account) });
  if (s.removed) return t("usageViews.agent.removedPart", { percent });
  return t("usageViews.agent.oldPart", { percent, brand: brandOf({ kind: s.kind ?? "claude_code", provider: null }) });
}
