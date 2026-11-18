import type { Agent } from "@agenteschat/client";
import { useAiStatus, useModels } from "@agenteschat/client";
import { agentThinks } from "@agenteschat/client/lib/brain";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/** Who thinks for the agent (`agentThinks`), from the workspace's directory, models and AI status. */
export function useAgentThinks(agent: Agent | undefined) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const models = useModels();
  const status = useAiStatus(org.id).data;
  if (!agent) return null;
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  return agentThinks(t, agent, {
    owner: owner?.name.split(" ")[0],
    agents: dir.agents,
    models: models.data?.models ?? [],
    ...(status ? { status } : {}),
  });
}
