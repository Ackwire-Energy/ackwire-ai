import { useLocalSearchParams } from "expo-router";
import { NewAgentScreen } from "@/features/agents/NewAgentScreen";

/**
 * "Criar agente" in steps; `?what=` (the examples of an empty Conversas) starts from scratch with that text;
 * `?proposal=` (an agent's proposal card, ADR 0081) starts on Revisar with its draft; `?import=1` (Configurações ›
 * Importar e exportar) opens on bringing agents from another app.
 */
export default function NewAgentRoute() {
  const {
    what,
    proposal,
    import: fromApp,
  } = useLocalSearchParams<{ what?: string; proposal?: string; import?: string }>();
  return (
    <NewAgentScreen
      initialWhat={typeof what === "string" ? what.slice(0, 500) : ""}
      proposalId={typeof proposal === "string" && proposal ? proposal : null}
      startImport={fromApp === "1"}
    />
  );
}
