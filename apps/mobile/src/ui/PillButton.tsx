import { type AccessibilityRole, Text as RNText, StyleSheet, View } from "react-native";
import { PressScale } from "./PressScale";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/**
 * A small raised pill beside a line (Desfazer under an agent's change, Abrir on a team check): the whole pill
 * presses, its word centered in it, quiet figures after it when it has a `detail` (the time left to undo).
 * `onPress` brings its own haptic, if any.
 */
export function PillButton({
  label,
  detail,
  onPress,
  accessibilityLabel,
  accessibilityRole = "button",
}: {
  label: string;
  /** After the word, quieter, in tabular figures ("4:31"). */
  detail?: string;
  onPress: () => void;
  /** Read aloud instead of the label (the time left to undo). */
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
}) {
  const { colors, shadows } = useTheme();
  return (
    <PressScale
      to={0.95}
      haptic={false}
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={6}
      style={[styles.pill, { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
    >
      {/* The press area fills the pill; the word alone in it sat at its top. */}
      <View style={styles.face}>
        <RNText
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText("footnote", weights.semibold), { color: colors.ink }]}
        >
          {label}
          {detail ? (
            <RNText style={[systemText("caption"), styles.detail, { color: colors.faint }]}>{` ${detail}`}</RNText>
          ) : null}
        </RNText>
      </View>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  pill: { height: 32, borderRadius: 16 },
  face: { flexGrow: 1, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  detail: { fontVariant: ["tabular-nums"] },
});
