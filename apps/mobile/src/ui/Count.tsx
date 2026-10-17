import { Text as RNText, View } from "react-native";
import { useTheme } from "./theme";

export interface CountProps {
  value: number;
  /** Font size (default 14). */
  size?: number;
  /** A badge: the number in the background color on an ink pill (unread counts, tab badges). */
  inverted?: boolean;
  /** Text color override (e.g. on a selected filter). */
  color?: string;
}

/** Every counter in the app: Doto, ROND 100 instance, tabular. */
export function Count({ value, size = 14, inverted = false, color }: CountProps) {
  const { colors, fonts } = useTheme();
  const label = String(value);
  if (inverted) {
    const h = Math.round(size * 1.45);
    return (
      <View
        style={{
          minWidth: h,
          height: h,
          paddingHorizontal: Math.round(size * 0.42),
          borderRadius: 999,
          backgroundColor: colors.ink,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <RNText
          style={{ fontFamily: fonts.dot, fontSize: size, lineHeight: h - 2, color: color ?? colors.bg }}
          allowFontScaling={false}
        >
          {label}
        </RNText>
      </View>
    );
  }
  return (
    <RNText
      style={{ fontFamily: fonts.dot, fontSize: size, lineHeight: Math.round(size * 1.2), color: color ?? colors.ink }}
    >
      {label}
    </RNText>
  );
}
