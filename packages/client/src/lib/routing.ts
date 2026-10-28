import type { TFunction } from "i18next";
import type { AiRouting, AiStatus, DecidedBy } from "../api/types";
import type { ReceiptView } from "../realtime/receipts";
import { agentGrammar } from "./grammar";
import { planLabel, planMark } from "./no-ai";
import { providerLabel } from "./providers";

/**
 * Whether something reads this person's messages that mention nobody (Jev, a small model, or their own plan), so an
 * agent set to answer on its own can join in (ADR 0074). An older server says nothing: as before, yes.
 */
export const picksForMe = (routing: AiRouting | undefined) =>
  !routing || routing.mine === "jev" || routing.mine === "model" || routing.mine === "plan";

/** What "On its own" means for this person's messages: the topic, only replies and follow-ups, or only mentions. */
export const replyAloneKey = (routing: AiRouting | undefined) =>
  picksForMe(routing)
    ? "channelMembers.replyAloneHelp"
    : routing?.mine === "off"
      ? "channelMembers.replyAloneOff"
      : "channelMembers.replyAloneRules";

/**
 * The line on who picks the agents now, by `ai-status`: its key and words. Null while it loads, in a workspace with
 * no AI, and for a small model the catalog can't name.
 */
export function routingLineOf(status: AiStatus | undefined, modelLabel: (id: string) => string | null) {
  const routing = status?.any ? status.routing : undefined;
  if (!routing) return null;
  if (routing.by === "model") {
    const model = routing.model ? modelLabel(routing.model) : null;
    return model ? { key: "routing.by.model" as const, params: { model } } : null;
  }
  if (routing.by === "rules" && routing.noSmallModel)
    return { key: "routing.by.noSmall" as const, params: { provider: providerLabel(routing.noSmallModel) } };
  return { key: `routing.by.${routing.by}` as const, params: {} };
}

/** Who picked the agents, as the receipt's last line: Jev's, the model's or the plan's mark, or the rule it followed. */
export interface Decider {
  mark: { logo: string } | { rule: Extract<DecidedBy, { step: "rule" }>["rule"] };
  text: string;
}

/**
 * The receipt's last line, once an agent was picked (ADR 0074). Null for a decision for nobody (the line under the
 * message says it), one made before the server said who decided, and a model the catalog can't name yet.
 */
export function deciderOf(
  t: TFunction,
  view: ReceiptView,
  names: {
    meId: string | null | undefined;
    agent: (id: string) => string;
    person: (userId: string) => string;
    model: (id: string) => string | null;
  },
): Decider | null {
  const by = view.decidedBy;
  const status = view.status;
  const first = status && status.kind !== "nobody" && status.kind !== "no_ai" ? status.agents[0] : undefined;
  if (!by || first === undefined) return null;
  if (by.step === "jev") return { mark: { logo: "typesafe" }, text: t("receipts.by.jev") };
  if (by.step === "model") {
    const model = names.model(by.model);
    return model ? { mark: { logo: by.provider }, text: t("receipts.by.model", { model }) } : null;
  }
  if (by.step === "plan") {
    const brand = planLabel(t, by.brand);
    const text =
      by.ownerId === names.meId
        ? t("receipts.by.planYours", { brand })
        : t("receipts.by.planOf", { brand, person: names.person(by.ownerId) });
    return { mark: { logo: planMark(by.brand) }, text };
  }
  return { mark: { rule: by.rule }, text: t(`receipts.by.${by.rule}`, agentGrammar(t, names.agent(first))) };
}
