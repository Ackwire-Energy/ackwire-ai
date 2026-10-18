import type { ReactNode } from "react";
import { Platform, Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, type OS, type TypeStyle, typeStyle, type Weight, weights } from "./type-scale";

export type TextVariant =
  | "display"
  | "title2"
  | "title"
  | "body"
  | "callout"
  | "subhead"
  | "small"
  | "footnote"
  | "label"
  | "caption";
export type TextTone = "ink" | "ink2" | "muted" | "faint" | "danger" | "ok";

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  children?: ReactNode;
}

const DEFAULT_TONE: Record<TextVariant, TextTone> = {
  display: "ink",
  title2: "ink",
  title: "ink",
  body: "ink",
  callout: "ink",
  subhead: "ink",
  small: "muted",
  footnote: "muted",
  label: "faint",
  caption: "faint",
};

export const os: OS = Platform.OS === "android" ? "android" : "ios";

/** A system-font style from the native scale (for raw `RNText`/`TextInput` in the design system). */
export function systemText(style: TypeStyle, fontWeight?: Weight): TextStyle {
  return typeStyle(os, style, fontWeight);
}

/** Where each variant sits on the native scale (`display` is the brand's large title, not the system font). */
const VARIANT_STYLE: Record<Exclude<TextVariant, "display">, [TypeStyle, Weight?]> = {
  title2: ["title2", weights.semibold],
  title: ["headline"],
  body: ["body"],
  callout: ["callout"],
  subhead: ["subhead"],
  small: ["subhead"],
  footnote: ["footnote"],
  label: ["footnote", weights.semibold],
  caption: ["caption"],
};

/**
 * Variants: display 34 (Funnel Display Light, the brand), title2 22 semibold, title 17 semibold (headline),
 * body 17/22, callout 16/21, subhead/small 15/20, footnote 13/18, label 13 semibold, caption 12/16
 * (iOS HIG sizes; Material 3 on Android). Everything but display uses the system font.
 */
export function variantStyle(variant: TextVariant, fonts: ReturnType<typeof useTheme>["fonts"]): TextStyle {
  if (variant === "display") return { fontFamily: fonts.display, fontSize: 34, lineHeight: 37, letterSpacing: -0.68 };
  const [style, weight] = VARIANT_STYLE[variant];
  return systemText(style, weight);
}

/** Variants that are chrome (timestamps, meta) or already big grow less with the text size setting. */
const MAX_SCALE: Partial<Record<TextVariant, number>> = { display: CHROME_MAX_SCALE, caption: CHROME_MAX_SCALE };

/** Text in the design system's scale and tones. Names stay in ink; counts use `Count`. */
export function Text({ variant = "body", tone, style, maxFontSizeMultiplier, ...rest }: TextProps) {
  const { colors, fonts } = useTheme();
  const color = colors[tone ?? DEFAULT_TONE[variant]];
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? MAX_SCALE[variant]}
      style={[variantStyle(variant, fonts), { color }, style]}
    />
  );
}
