import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { ComputerSky, Glass, Icon, type IconName, PixelOrbit, Text, useTheme } from "@/ui";
import { DEFAULT_DESKTOP } from "./screen-view";

/**
 * The stage with nothing live on it, as on the web: what it is and why on a glass card, with the agent's pixel spinner
 * while something is on its way.
 */
export function Cover({
  icon,
  art,
  spinner = false,
  sky = false,
  color = "sky",
  text,
  help,
  action,
  fill = false,
}: {
  icon?: IconName;
  art?: ReactNode;
  spinner?: boolean;
  /** The agent's sky behind it, at the screen's shape (a screen opening). */
  sky?: boolean;
  color?: AgentColorName;
  text: string;
  help?: string;
  action?: ReactNode;
  /** Over the live screen's box, filling it. */
  fill?: boolean;
}) {
  const { colors: c, shadows } = useTheme();
  return (
    <View
      style={[
        styles.cover,
        sky && !fill && styles.stage,
        fill && StyleSheet.absoluteFill,
        { backgroundColor: c.sunken },
      ]}
    >
      {sky ? <ComputerSky color={color} style={StyleSheet.absoluteFill} /> : null}
      <View style={[styles.lift, { boxShadow: shadows.e2 }]}>
        <Glass style={styles.card}>
          {art}
          <View style={styles.row}>
            {spinner ? (
              <PixelOrbit color={color} size={16} />
            ) : icon ? (
              <Icon name={icon} size={16} color={c.ink} />
            ) : null}
            <Text variant="subhead" tone="ink" style={styles.text}>
              {text}
            </Text>
          </View>
          {help ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {help}
            </Text>
          ) : null}
          {action}
        </Glass>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: "center" },
  cover: {
    minHeight: 220,
    borderRadius: 18,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  stage: { aspectRatio: DEFAULT_DESKTOP.width / DEFAULT_DESKTOP.height },
  lift: { maxWidth: "100%", borderRadius: 14 },
  card: { alignItems: "center", gap: 10, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  text: { flexShrink: 1, fontWeight: "600", textAlign: "center" },
});
