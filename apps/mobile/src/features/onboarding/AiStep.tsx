import { type AiChoice, defaultChoice, firstAgent, gateDims } from "@agenteschat/client/lib/no-ai";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ConnectKey } from "@/features/ai/ConnectAi";
import { AiPicker, KeyPanel, PlanPanel, usePlanGates } from "@/features/ai/ConnectAiSteps";
import { AiOrgProvider } from "@/features/ai/org";
import { openPage } from "@/features/ai/parts";
import { serverUrl } from "@/lib/server";

/**
 * The first run's AI step, as the web's (`OnboardingPage`, "Qual IA eles vão usar?"): the same picker as Connect
 * an AI, for the workspace just created. The plans first, each signing in on the agent's computer, then the API
 * key, saved by the step's button. `planned`: the agents that think with a plan connected here.
 */
export function AiStep({
  orgId,
  orgName,
  agents,
  form,
  choice: picked,
  onChoice,
  planned,
  onPlanned,
  onShown,
}: {
  orgId: string;
  orgName: string;
  agents: { id: string; name: string }[];
  form: ConnectKey;
  choice: AiChoice | null;
  onChoice: (choice: AiChoice) => void;
  planned: string[];
  onPlanned: (agentId: string) => void;
  /** The option on screen (the chosen one, or the one it opens on): the step's button follows it. */
  onShown: (choice: AiChoice) => void;
}) {
  const hasAi = (id: string) => planned.includes(id);
  const [pickedAgent, setPickedAgent] = useState<string>();
  const agentId = pickedAgent ?? firstAgent(agents, hasAi)?.id ?? agents[0]?.id;
  const gates = usePlanGates(orgId, agentId);
  const choice =
    picked ??
    defaultChoice({
      intent: undefined,
      ownsAgents: agents.length > 0,
      mayAddKey: true,
      claudeGate: agentId ? gates.gateOf("claude") : { state: "loading" },
    });
  useEffect(() => onShown(choice), [choice, onShown]);
  return (
    <AiOrgProvider value={{ orgId, org: { name: orgName } }}>
      <View style={styles.body}>
        <AiPicker choice={choice} onPick={onChoice} dims={(c) => agentId !== undefined && gateDims(gates.gateOf(c))} />
        {choice === "key" ? (
          <KeyPanel
            draft={{ provider: form.provider, apiKey: form.key }}
            onDraft={(d) => {
              if (d.provider !== form.provider) form.setProvider(d.provider);
              if (d.apiKey !== form.key) form.setKey(d.apiKey);
            }}
            failed={form.failed}
          />
        ) : (
          <PlanPanel
            key={choice}
            choice={choice}
            gates={gates}
            agents={agents}
            agentId={agentId}
            onAgent={setPickedAgent}
            onKey={() => onChoice("key")}
            onComputer={() => openPage(`${serverUrl()}/org/${orgId}/settings/computers`)}
            onDone={(id) => {
              // The panel stays on that agent, saying it's done.
              setPickedAgent(id);
              onPlanned(id);
            }}
          />
        )}
      </View>
    </AiOrgProvider>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16 },
});
