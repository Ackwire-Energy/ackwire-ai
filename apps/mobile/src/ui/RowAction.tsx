import { type AccessibilityRole, Text as RNText, StyleSheet, View } from "react-native";
import { PressScale } from "./PressScale";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/**
 * A row's action beside a line (Desfazer under an agent's change, Abrir on a team check): words only, as the web's
 * `.ag-rc__btn`, as tall as the line's first row so they share a middle, quiet figures after them when it has a
 * `detail` (the time left to undo). `onPress` brings its own haptic, if any.
 */
export function RowAction({
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
  const { colors } = useTheme();
  return (
    <PressScale
      to={0.95}
      haptic={false}
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={6}
      style={styles.row}
    >
      {/* The press area fills the row; the word alone in it sat at its top. */}
      <View style={styles.face}>
        <RNText
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText("footnote", weights.semibold), styles.word, { color: colors.muted }]}
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
  row: { height: 32 },
  face: { flexGrow: 1, paddingHorizontal: 4, alignItems: "center", justifyContent: "center" },
  word: { fontSize: 14 },
  detail: { fontVariant: ["tabular-nums"] },
});
