import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { ReactNode } from "react";
import { View } from "react-native";
import { Sky } from "@/sky/Sky";
import { Text } from "./Text";

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  /** A small pixel sky above the text (only where the subject is agents). */
  sky?: boolean;
  color?: AgentColorName;
  /** One way out under the text (a `Button`), centered at its own size. */
  action?: ReactNode;
}

/** Nothing here yet: one calm line, optionally under a bit of sky, optionally with one way out. */
export function EmptyState({ title, subtitle, sky = false, color = "sky", action }: EmptyStateProps) {
  return (
    // Stretched to its container's width (the sky spans it), whatever the container centers.
    <View style={{ alignSelf: "stretch", alignItems: "center", paddingHorizontal: 20, paddingVertical: 40 }}>
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
      {action ? (
        // A row sized to its content: the button keeps its own width and height (in a column it could take
        // the flex space it sits in, and its own `alignSelf` would pin it to the left edge).
        <View style={{ flexDirection: "row", alignSelf: "center", marginTop: 20 }}>{action}</View>
      ) : null}
    </View>
  );
}
