import { Text as RNText, View } from "react-native";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE } from "./type-scale";

export interface CountProps {
  value: number;
  /** Font size (default 14). */
  size?: number;
  /** A badge: the number in the background color on an ink pill (unread counts, tab badges). */
  inverted?: boolean;
  /** Text color override (e.g. on a selected filter). */
  color?: string;
  /** Past this, shows "max+" (unread counts: the server stops counting at 100). */
  max?: number;
}

/** Every counter in the app: Doto, ROND 100 instance, tabular. */
export function Count({ value, size = 14, inverted = false, color, max }: CountProps) {
  const { colors, fonts } = useTheme();
  const label = max !== undefined && value > max ? `${max}+` : String(value);
  if (inverted) {
    const h = Math.round(size * 1.45);
    return (
      <View
        style={{
          minWidth: h,
          minHeight: h,
          paddingHorizontal: Math.round(size * 0.42),
          borderRadius: 999,
          backgroundColor: colors.ink,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <RNText
          style={{ fontFamily: fonts.dot, fontSize: size, lineHeight: h - 2, color: color ?? colors.bg }}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
        >
          {label}
        </RNText>
      </View>
    );
  }
  return (
    <RNText
      maxFontSizeMultiplier={CHROME_MAX_SCALE}
      style={{ fontFamily: fonts.dot, fontSize: size, lineHeight: Math.round(size * 1.2), color: color ?? colors.ink }}
    >
      {label}
    </RNText>
  );
}
