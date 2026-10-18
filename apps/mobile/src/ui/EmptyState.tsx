import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { View } from "react-native";
import { Sky } from "@/sky/Sky";
import { Text } from "./Text";

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  /** A small pixel sky above the text (only where the subject is agents). */
  sky?: boolean;
  color?: AgentColorName;
}

/** Nothing here yet: one calm line, optionally under a bit of sky. */
export function EmptyState({ title, subtitle, sky = false, color = "sky" }: EmptyStateProps) {
  return (
    <View style={{ alignItems: "center", paddingHorizontal: 20, paddingVertical: 40 }}>
      {sky ? (
        <View style={{ alignSelf: "stretch", height: 110, marginBottom: 12 }}>
          <Sky color={color} depth={0.6} style={{ flex: 1 }} />
        </View>
      ) : null}
      <Text variant="callout" tone="faint" style={{ fontWeight: "500", textAlign: "center" }}>
        {title}
      </Text>
      {subtitle ? (
        <Text variant="subhead" tone="faint" style={{ textAlign: "center", marginTop: 4 }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
