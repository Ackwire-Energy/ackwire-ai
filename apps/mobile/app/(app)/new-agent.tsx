import { useLocalSearchParams } from "expo-router";
import { NewAgentForm } from "@/features/new/NewAgentForm";

/** "Novo agente" as a native form sheet; `?what=` fills in what it does (the examples of an empty Conversas). */
export default function NewAgentRoute() {
  const { what } = useLocalSearchParams<{ what?: string }>();
  return <NewAgentForm initialWhat={typeof what === "string" ? what.slice(0, 500) : ""} />;
}
