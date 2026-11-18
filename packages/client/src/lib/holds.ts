import type { TFunction } from "i18next";
import type { Hold } from "../api/types";
import { upcomingAt, whenAt } from "./format";

/**
 * A hold's line on the agent's computer (ADR 0176): what is kept, then which agent kept it, since when and until when.
 * It never says the computer stays awake, sleeps or pauses: people see what runs for them, whatever the computer does.
 */
export function holdLine(t: TFunction, hold: Hold, o: { agent: string; locale: string; now: Date }) {
  const until = hold.until
    ? t("agentComputer.kept.until", { time: upcomingAt(t, o.locale, hold.until, o.now) })
    : t(hold.kind === "browser" ? "agentComputer.kept.untilClosed" : "agentComputer.kept.untilStops");
  return {
    what: hold.what,
    meta: t("agentComputer.kept.meta", { name: o.agent, since: whenAt(t, o.locale, hold.since, o.now), until }),
  };
}
