import type { ReactNode } from "react";
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import { useTheme } from "./theme";

export type TextVariant = "body" | "small" | "title" | "display" | "label" | "caption";
export type TextTone = "ink" | "ink2" | "muted" | "faint" | "danger" | "ok";

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  children?: ReactNode;
}

const DEFAULT_TONE: Record<TextVariant, TextTone> = {
  body: "ink",
  small: "muted",
  title: "ink",
  display: "ink",
  label: "faint",
  caption: "faint",
};

/** Type scale from Mobile.html: body 15, small 13.5, title 17, display 34 (Funnel Display Light), label 13, caption 12. */
export function variantStyle(variant: TextVariant, fonts: ReturnType<typeof useTheme>["fonts"]): TextStyle {
  switch (variant) {
    case "display":
      return { fontFamily: fonts.display, fontSize: 34, lineHeight: 37, letterSpacing: -0.68 };
    case "title":
      return { fontFamily: fonts.semibold, fontSize: 17, lineHeight: 22, letterSpacing: -0.1 };
    case "small":
      return { fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 19 };
    case "label":
      return { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 17 };
    case "caption":
      return { fontFamily: fonts.medium, fontSize: 12, lineHeight: 16 };
    default:
      return { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22 };
  }
}

/** Text in the design system's scale and tones. Names stay in ink; counts use `Count`. */
export function Text({ variant = "body", tone, style, ...rest }: TextProps) {
  const { colors, fonts } = useTheme();
  const color = colors[tone ?? DEFAULT_TONE[variant]];
  return <RNText {...rest} style={[variantStyle(variant, fonts), { color }, style]} />;
}
