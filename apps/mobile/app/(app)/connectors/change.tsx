import { useLocalSearchParams } from "expo-router";
import { ToolChangeScreen } from "@/features/connectors/ToolChanges";

/** One changed tool of a connection (`id`, `tool`), pushed over its Ferramentas: what changed, and Aceitar. */
export default function ConnectorToolChangeRoute() {
  const { id, tool } = useLocalSearchParams<{ id: string; tool: string }>();
  return <ToolChangeScreen connectionId={id ?? ""} toolName={tool ?? ""} />;
}
