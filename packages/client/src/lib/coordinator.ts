import type { TFunction } from "i18next";
import type { Agent } from "../api/types";
import { agentGrammar } from "./grammar";

/**
 * The line under an agent's "Coordena o time" switch (ADR 0093): who coordinates the team when it isn't this agent,
 * and, with the switch turned on, that one agent coordinates at a time. Null when this agent already does.
 */
export function coordinatorNote(
  t: TFunction,
  agents: Pick<Agent, "id" | "name" | "coordinator">[],
  agentId: string,
  on: boolean,
): string | null {
  const now = agents.find((a) => a.coordinator);
  if (now?.id === agentId) return null;
  if (!now) return t("coordinator.none");
  const line = t("coordinator.current", agentGrammar(now.name));
  return on ? `${line} ${t("coordinator.one")}` : line;
}
