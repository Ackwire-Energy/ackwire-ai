import type { Agent } from "@agenteschat/client";
import { useModels } from "@agenteschat/client";
import { brainLine } from "@agenteschat/client/lib/brain";
import { apiProviderOf, isAuto } from "@agenteschat/client/lib/providers";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/** Who thinks: on a plan, the model by the plan that pays for it ("Sonnet pelo plano do Claude"), else the API model. */
export function useAgentThinks(agent: Agent | undefined) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const models = useModels();
  if (!agent) return null;
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const model = isAuto(agent.model)
    ? t("brain.auto.label")
    : (models.data?.models.find((m) => m.id === agent.model)?.label ?? agent.model);
  const thinks = brainLine(t, agent.brain, model, { owner: owner?.name.split(" ")[0], agents: dir.agents });
  // The API's maker when it thinks through a key.
  return { ...thinks, mark: thinks.mark ?? apiProviderOf(agent.model, models.data?.models ?? []) };
}
