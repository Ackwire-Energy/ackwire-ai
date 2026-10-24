import type { MachineAccount, MachineAccountKind, PlanUsage } from "@agenteschat/client";
import { daysBetween, formatShortDate, formatTime, relativeTime } from "@agenteschat/client/lib/format";
import { type PlanMeterText, planState } from "@agenteschat/ui";
import type { TFunction } from "i18next";

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
export function planMeterText(t: TFunction, locale: string, now = new Date()): PlanMeterText {
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

/** The plan's state in a few words, for a line that has no room for the meter; null when it is fine. */
export function planWord(t: TFunction, locale: string, usage: PlanUsage | null | undefined, now = new Date()) {
  if (!usage) return null;
  const { state, until } = planState(usage, now.getTime());
  const text = planMeterText(t, locale, now);
  return state === "limited" ? text.limited(until) : state === "almost" ? text.almost : null;
}

/**
 * At the limit, the owner's other accounts that could think instead: of the
 * same kind, signed in, not at their own limit and free. One another agent
 * thinks with is never offered (an account serves one agent; moving plans
 * between agents to dodge a limit isn't). Most headroom first, unknown usage last.
 */
export function limitOffers(
  accounts: readonly MachineAccount[],
  kind: MachineAccountKind,
  current: string | null,
  now = Date.now(),
): { account: MachineAccount; used: number | null }[] {
  return accounts
    .filter((a) => a.mine && a.kind === kind && a.id !== current && a.status === "active" && a.usedBy.length === 0)
    .map((account) => ({ account, plan: account.usage ? planState(account.usage, now) : null }))
    .filter((o) => o.plan?.state !== "limited")
    .map((o) => ({ account: o.account, used: o.plan?.used ?? null }))
    .sort((a, b) => (a.used ?? 101) - (b.used ?? 101));
}
