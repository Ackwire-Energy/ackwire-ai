import { useLocalSearchParams } from "expo-router";
import { LiveView } from "@/features/browser/LiveView";

/** An agent's browser, live and full screen (presentation set in `_layout`): `/browser/<agentId>`. */
export default function BrowserRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  return <LiveView agentId={agentId} />;
}
