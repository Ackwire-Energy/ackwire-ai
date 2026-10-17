import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { Text as RNText, View } from "react-native";
import { Sky } from "@/sky/Sky";
import { useTheme } from "./theme";

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  /** A small pixel sky above the text (only where the subject is agents). */
  sky?: boolean;
  color?: AgentColorName;
}

/** Nothing here yet: one calm line, optionally under a bit of sky. */
export function EmptyState({ title, subtitle, sky = false, color = "sky" }: EmptyStateProps) {
  const { colors, fonts } = useTheme();
  return (
    <View style={{ alignItems: "center", paddingHorizontal: 20, paddingVertical: 40 }}>
      {sky ? (
        <View style={{ alignSelf: "stretch", height: 110, marginBottom: 12 }}>
          <Sky color={color} depth={0.6} style={{ flex: 1 }} />
        </View>
      ) : null}
      <RNText
        style={{ fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.faint, textAlign: "center" }}
      >
        {title}
      </RNText>
      {subtitle ? (
        <RNText
          style={{
            fontFamily: fonts.sans,
            fontSize: 13.5,
            lineHeight: 19,
            color: colors.faint,
            textAlign: "center",
            marginTop: 4,
          }}
        >
          {subtitle}
        </RNText>
      ) : null}
    </View>
  );
}
