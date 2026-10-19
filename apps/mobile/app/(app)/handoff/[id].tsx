import { useBrowserHandoff } from "@agenteschat/client";
import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { LiveView } from "@/features/browser/LiveView";
import { useOrgId } from "@/features/shared/hooks";
import { useTheme } from "@/ui";

/**
 * An agent's request for help in its browser (the chat card, the push, "Esperando você"): the live view of
 * that agent's browser, taking the control (`/handoff/<id>`, deep link `agenteschat://handoff/<id>`).
 */
export default function HandoffRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const orgId = useOrgId();
  const { colors } = useTheme();
  const handoff = useBrowserHandoff(orgId, id);
  if (!handoff.data) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return <LiveView agentId={handoff.data.agentId} handoffId={id} />;
}
