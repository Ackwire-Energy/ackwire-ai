import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { ReactNode } from "react";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { needsHeaderBlur } from "@/lib/nav";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { Glass, haptics, PressScale, Text, useTheme } from "@/ui";

/**
 * The conversation's title as a glass pill in the header: who
 * or where on the left, the name and a quiet line under it. An agent's pill carries a little of its sky at
 * the right end; while it works, a pixel sweep in its color crosses the pill (the sidebar's trail) and the
 * quiet line says what it is doing. A channel shows who is in on the right. Held (`onHold`), it opens the
 * conversation switcher.
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
  extraActions = 0,
  onHold,
  holdHint,
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
  /** Bar buttons beside "…" (an agent's computer): the centered pill gives up twice their 40 points each. */
  extraActions?: number;
  onHold?: () => void;
  /** What a screen reader says the hold does. */
  holdHint?: string;
}) {
  const { colors, shadows } = useTheme();
  const { width } = useWindowDimensions();
  return (
    <PressScale
      to={0.97}
      onPress={onPress}
      disabled={!onPress && !onHold}
      {...(onHold
        ? {
            delayLongPress: 300,
            onLongPress: () => {
              haptics.medium();
              onHold();
            },
          }
        : {})}
      accessibilityRole={onPress ? "button" : "header"}
      accessibilityLabel={label}
      accessibilityHint={holdHint}
      style={[
        styles.press,
        { maxWidth: Math.max(160, width - 136 - extraActions * 80) },
        // Android's pill is opaque: a short shadow floats it over the conversation, as the glass does on iOS.
        Platform.OS === "android" && { borderRadius: 22, boxShadow: shadows.e1 },
        LIQUID && styles.liquidNudge,
      ]}
    >
      {/* The same Liquid Glass as the bar's own buttons beside it (iOS 26); the blur and a hairline before. */}
      <Glass liquid intensity={70} style={[styles.pill, { borderColor: colors.line2 }]}>
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

/** iOS 26's bar: its glass buttons sit lower than a title view's center. */
const LIQUID = Platform.OS === "ios" && !needsHeaderBlur(Platform.OS, Platform.Version);

const styles = StyleSheet.create({
  press: { minWidth: 0 },
  // Level with the back and "…" circles beside it (they sat about 5 points lower); `top` moves it without
  // changing the size the bar lays out.
  liquidNudge: { top: 5 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    // Room on both sides: the name ran up to the pill's edge, under the agent's dither.
    gap: 12,
    height: 44,
    paddingLeft: 16,
    paddingRight: 32,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  lead: { alignItems: "center", justifyContent: "center", minWidth: 26 },
  text: { flexShrink: 1, minWidth: 0 },
  title: { fontWeight: "600", lineHeight: 20 },
  trailing: { flexDirection: "row", alignItems: "center", marginLeft: 2 },
});
