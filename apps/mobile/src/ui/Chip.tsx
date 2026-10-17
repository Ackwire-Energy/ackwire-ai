import type { ReactNode } from "react";
import { Text as RNText, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { useTheme } from "./theme";

export interface ChipProps {
  /** Chips carry an icon, never a colored dot. */
  icon?: IconName;
  label: string;
  /** Anything before the label instead of an icon (a small avatar). */
  leading?: ReactNode;
}

/** A small neutral tag: sunken pill, muted text. */
export function Chip({ icon, label, leading }: ChipProps) {
  const { colors, fonts } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        height: 24,
        paddingHorizontal: 9,
        borderRadius: 999,
        backgroundColor: colors.sunken,
        alignSelf: "flex-start",
      }}
    >
      {leading ?? (icon ? <Icon name={icon} size={13} color={colors.muted} /> : null)}
      <RNText numberOfLines={1} style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.muted }}>
        {label}
      </RNText>
    </View>
  );
}
