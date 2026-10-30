import { useLocalSearchParams } from "expo-router";
import { NewAgentScreen } from "@/features/agents/NewAgentScreen";

/**
 * "Criar agente" in steps; `?what=` (the examples of an empty Conversas) starts from scratch with that text;
 * `?proposal=` (an agent's proposal card, ADR 0080) starts on Revisar with its draft.
 */
export default function NewAgentRoute() {
  const { what, proposal } = useLocalSearchParams<{ what?: string; proposal?: string }>();
  return (
    <NewAgentScreen
      initialWhat={typeof what === "string" ? what.slice(0, 500) : ""}
      proposalId={typeof proposal === "string" && proposal ? proposal : null}
    />
  );
}
