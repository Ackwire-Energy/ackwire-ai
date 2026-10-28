import { useLocalSearchParams } from "expo-router";
import { NewAgentScreen } from "@/features/agents/NewAgentScreen";

/** "Criar agente" in steps; `?what=` (the examples of an empty Conversas) starts from scratch with that text. */
export default function NewAgentRoute() {
  const { what } = useLocalSearchParams<{ what?: string }>();
  return <NewAgentScreen initialWhat={typeof what === "string" ? what.slice(0, 500) : ""} />;
}
