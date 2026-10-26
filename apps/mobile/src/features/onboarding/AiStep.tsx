import type { AiChoice } from "@agenteschat/client/lib/no-ai";
import { useEffect, useState } from "react";
import type { ConnectKey } from "@/features/ai/ConnectAi";
import { ConnectAiFlow, type FlowView } from "@/features/ai/ConnectAiSteps";
import { AiOrgProvider } from "@/features/ai/org";
import { openPage } from "@/features/ai/parts";
import { serverUrl } from "@/lib/server";

/**
 * The first run's AI step ("Qual IA eles vão usar?"): the same flow as Connect an AI (ConnectAiFlow), for the
 * workspace just created. The plans first, each signing in on the agent's computer, then the API key, saved by the
 * step's button. `planned`: the agents that think with a plan connected here.
 */
export function AiStep({
  orgId,
  orgName,
  agents,
  form,
  planned,
  onPlanned,
  onShown,
}: {
  orgId: string;
  orgName: string;
  agents: { id: string; name: string }[];
  form: ConnectKey;
  planned: string[];
  onPlanned: (agentId: string) => void;
  /** The page on screen ("key" on the key's page): the step's button follows it. */
  onShown: (choice: AiChoice | null) => void;
}) {
  const [view, setView] = useState<FlowView>({ page: "home" });
  useEffect(() => onShown(view.page === "key" ? "key" : view.page === "plan" ? view.choice : null), [view, onShown]);
  return (
    <AiOrgProvider value={{ orgId, org: { name: orgName } }}>
      <ConnectAiFlow
        view={view}
        onView={setView}
        agents={agents}
        hasAi={(id) => planned.includes(id)}
        mayAddKey
        keyForm={form}
        keyButton={false}
        onComputer={() => openPage(`${serverUrl()}/org/${orgId}/settings/computers`)}
        onPlanDone={onPlanned}
      />
    </AiOrgProvider>
  );
}
