import { useLocalSearchParams } from "expo-router";
import { DeleteAgentScreen } from "@/features/agents/DeleteAgentScreen";

/** "Apagar agente" (`?id=`), pushed over "Editar agente". */
export default function AgentDeleteRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DeleteAgentScreen key={id} id={id} />;
}
