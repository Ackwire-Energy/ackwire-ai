import type { PlanUsage } from "@agenteschat/client";
import { planMeterText } from "@agenteschat/client/lib/plan-usage";
import { planState } from "@agenteschat/ui";
import type { TFunction } from "i18next";

// At the limit, the owner's other accounts that could think instead: shared with the phone.
export { limitOffers } from "@agenteschat/ui";
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
