import type { AiRouting, AiStatus } from "../api/types";
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
