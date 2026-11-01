import type { Agent } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Chip } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/** "Coordena o time" by the agent that coordinates the team (ADR 0093), with what that means as its tooltip. */
export function CoordinatorChip({ agent }: { agent: Pick<Agent, "name" | "coordinator"> }) {
  const { t } = useTranslation();
  if (!agent.coordinator) return null;
  return (
    <Chip icon="flag" title={t("coordinator.help", agentGrammar(t, agent.name))}>
      {t("coordinator.chip")}
    </Chip>
  );
}
