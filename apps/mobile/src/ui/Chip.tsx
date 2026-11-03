import type { ReactNode } from "react";
import { Text as RNText, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export interface ChipProps {
  /** Chips carry an icon, never a colored dot. */
  icon?: IconName;
  label: string;
  /** Anything before the label instead of an icon (a small avatar). */
  leading?: ReactNode;
  /** Words after the label that never shrink (a state): a long label ends in "…" first. */
  trailing?: string;
}

/** A small neutral tag: a light gray pill, muted text. */
export function Chip({ icon, label, leading, trailing }: ChipProps) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        minHeight: 24,
        paddingHorizontal: 9,
        borderRadius: 999,
        backgroundColor: colors.chip,
        alignSelf: "flex-start",
        // In a tight row the label ends in "…" instead of the chip leaving the row.
        maxWidth: "100%",
      }}
    >
      {leading ?? (icon ? <Icon name={icon} size={13} color={colors.muted} /> : null)}
      <RNText
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={[systemText("caption", weights.semibold), { color: colors.muted, flexShrink: 1 }]}
      >
        {label}
      </RNText>
      {trailing ? (
        <RNText
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText("caption", weights.regular), { color: colors.muted, flexShrink: 0 }]}
        >
          {trailing}
        </RNText>
      ) : null}
    </View>
  );
}
