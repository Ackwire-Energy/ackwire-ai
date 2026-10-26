import type { MachineAccount, MachineAccountKind, PlanUsage } from "@agenteschat/client";
import { planMeterText } from "@agenteschat/client/lib/plan-usage";
import { planState } from "@agenteschat/ui";
import type { TFunction } from "i18next";

// The words of the usage views live in the client, shared with the phone (ADR 0063).
export {
  accountName,
  brandOf,
  noWindowsText,
  partedUsage,
  planMeterText,
  usageSourceName,
  usageSourcePart,
} from "@agenteschat/client/lib/plan-usage";

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
