import type {
  AgentUsageSource,
  MachineAccount,
  MachineAccountKind,
  PlanAccountInfo,
  PlanAccountUsage,
  PlanUsage,
  PlanWindowParts,
} from "@agenteschat/client";
import { daysBetween, formatPercent, formatShortDate, formatTime, relativeTime } from "@agenteschat/client/lib/format";
import { planOf } from "@agenteschat/client/lib/plans";
import { type PlanMeterText, type PlanMeterUsage, planState } from "@agenteschat/ui";
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
 * same kind and plan maker (another maker's models would think instead),
 * signed in, not at their own limit and free. One another agent thinks with
 * is never offered (an account serves one agent; moving plans between agents
 * to dodge a limit isn't). Most headroom first, unknown usage last.
 */
export function limitOffers(
  accounts: readonly MachineAccount[],
  kind: MachineAccountKind,
  current: string | null,
  now = Date.now(),
): { account: MachineAccount; used: number | null }[] {
  const provider = accounts.find((a) => a.id === current)?.provider ?? null;
  return accounts
    .filter(
      (a) =>
        a.mine &&
        a.kind === kind &&
        (a.provider ?? null) === provider &&
        a.id !== current &&
        a.status === "active" &&
        a.usedBy.length === 0,
    )
    .map((account) => ({ account, plan: account.usage ? planState(account.usage, now) : null }))
    .filter((o) => o.plan?.state !== "limited")
    .map((o) => ({ account: o.account, used: o.plan?.used ?? null }))
    .sort((a, b) => (a.used ?? 101) - (b.used ?? 101));
}

/**
 * An account's windows for `PlanMeter` with whose use they are (the usage views): `note` says each
 * window's parts in words; `focus` draws that agent's part in full ink (none where it has no estimate).
 */
export function partedUsage(
  usage: Omit<PlanUsage, "windows"> & { windows: PlanWindowParts[] },
  note: (parts: NonNullable<PlanWindowParts["agents"]>) => string | undefined,
  focus?: string,
): PlanMeterUsage {
  return {
    ...usage,
    windows: usage.windows.map(({ agents, ...w }) => ({
      ...w,
      ...(agents && agents.length > 0 ? { note: note(agents) } : {}),
      ...(agents && focus ? { part: agents.find((a) => a.agentId === focus)?.percent ?? 0 } : {}),
    })),
  };
}

/** What people call a plan account: its label, or "Conta deste MacBook" for the computer's own sign-in. */
export const accountName = (t: TFunction, a: Pick<PlanAccountInfo, "label" | "machineName">) =>
  a.label ?? t("agentPage.work.brain.thisComputer", { computer: a.machineName });

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

/** A source's share of the agent's month in a sentence: "97% na conta deste MacBook", "3% pela API". */
export function usageSourcePart(t: TFunction, locale: string, s: AgentUsageSource) {
  const percent = formatPercent(locale, s.share);
  if (s.type === "api") return t("usageViews.agent.apiPart", { percent });
  if (s.account?.accountId === null) {
    return t("usageViews.agent.computerPart", { percent, computer: s.account.machineName });
  }
  if (s.account) return t("usageViews.agent.accountPart", { percent, account: accountName(t, s.account) });
  if (s.removed) return t("usageViews.agent.removedPart", { percent });
  return t("usageViews.agent.oldPart", { percent, brand: brandOf({ kind: s.kind ?? "claude_code", provider: null }) });
}
