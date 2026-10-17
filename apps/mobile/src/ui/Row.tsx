import type { ReactNode } from "react";
import { Pressable, Text as RNText, View } from "react-native";
import { Icon } from "./Icon";
import { useTheme } from "./theme";

export interface RowProps {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  /** Right side: a time, a badge (`<Count inverted />`)… */
  meta?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  /** A hairline above (Card adds it between rows). */
  divider?: boolean;
}

/** A list row: leading avatar or tile, title in ink, a muted line, meta on the right. */
export function Row({ leading, title, subtitle, meta, chevron = false, onPress, divider = false }: RowProps) {
  const { colors, fonts } = useTheme();
  const body = (pressed: boolean) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
        minHeight: 60,
        backgroundColor: pressed ? "rgba(127, 127, 127, 0.08)" : "transparent",
      }}
    >
      {divider ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: leading ? 58 : 14,
            right: 0,
            height: 1,
            backgroundColor: colors.line,
          }}
        />
      ) : null}
      {leading}
      <View style={{ flex: 1, minWidth: 0 }}>
        <RNText
          numberOfLines={1}
          style={{ fontFamily: fonts.semibold, fontSize: 15, lineHeight: 20, color: colors.ink }}
        >
          {title}
        </RNText>
        {subtitle ? (
          <RNText
            numberOfLines={1}
            style={{ fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 19, color: colors.muted }}
          >
            {subtitle}
          </RNText>
        ) : null}
      </View>
      {meta ? <View style={{ alignItems: "flex-end", gap: 5 }}>{meta}</View> : null}
      {chevron ? <Icon name="right" size={16} color={colors.faint} /> : null}
    </View>
  );
  if (!onPress) return body(false);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}
