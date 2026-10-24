import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { ReactNode } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { Glass, PressScale, Text, useTheme } from "@/ui";

/**
 * The conversation's title as a glass pill in the header (telas/CabecalhoVidro.html, B · Céu na pílula): who
 * or where on the left, the name and a quiet line under it. An agent's pill carries a little of its sky at
 * the right end; while it works, a pixel sweep in its color crosses the pill (the sidebar's trail) and the
 * quiet line says what it is doing. A channel shows who is in on the right.
 */
export function HeaderPill({
  lead,
  title,
  subtitle,
  color,
  working = false,
  trailing,
  onPress,
  label,
}: {
  lead?: ReactNode;
  title: string;
  subtitle?: string | undefined;
  /** An agent's color: its sky lives in the pill. */
  color?: AgentColorName | undefined;
  working?: boolean;
  /** Faces of who is in (channels). */
  trailing?: ReactNode;
  onPress?: () => void;
  /** What a screen reader says (name, state and what a tap does). */
  label: string;
}) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  return (
    <PressScale
      to={0.97}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : "header"}
      accessibilityLabel={label}
      style={[styles.press, { maxWidth: Math.max(160, width - 136) }]}
    >
      <Glass intensity={70} style={[styles.pill, { borderColor: colors.line2 }]}>
        {color ? (
          <Dither
            kind={working ? "pillwork" : "pill"}
            tones={softTones(color, colors.glassSolid)}
            pixel={3}
            clear
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        {lead ? <View style={styles.lead}>{lead}</View> : null}
        <View style={styles.text} importantForAccessibility="no-hide-descendants">
          <Text variant="body" numberOfLines={1} style={styles.title}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      </Glass>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  press: { minWidth: 0 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    height: 44,
    paddingLeft: 9,
    paddingRight: 18,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  lead: { alignItems: "center", justifyContent: "center", minWidth: 26 },
  text: { flexShrink: 1, minWidth: 0 },
  title: { fontWeight: "600", lineHeight: 20 },
  trailing: { flexDirection: "row", alignItems: "center", marginLeft: 2 },
});
