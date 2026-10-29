import type { ReactNode } from "react";
import { Platform, Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import { useTheme } from "./theme";
import {
  CHROME_MAX_SCALE,
  type OS,
  readingMiddle,
  type TypeStyle,
  typeStyle,
  type Weight,
  weights,
} from "./type-scale";

export type TextVariant =
  | "display"
  | "display2"
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
  display2: "ink",
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

/**
 * The same for a one-line `TextInput`: no line height, which iOS adds under the text of a one-line field
 * (it sits lower than a label beside it). Multi-line fields keep `systemText`.
 */
export function fieldText(style: TypeStyle, fontWeight?: Weight): TextStyle {
  const { lineHeight: _drop, ...rest } = typeStyle(os, style, fontWeight);
  return rest;
}

/** Where each variant sits on the native scale. */
/** Large titles are bold on iOS (Mail, Settings) and regular on Android (Material headlines). */
const TITLE_WEIGHT = os === "ios" ? weights.bold : weights.regular;

const VARIANT_STYLE: Record<TextVariant, [TypeStyle, Weight?]> = {
  display: ["largeTitle", TITLE_WEIGHT],
  display2: ["title1", TITLE_WEIGHT],
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
 * Variants: display 34 bold (the large titles), display2 28 bold (a question or a heading inside a screen:
 * "O que você precisa?", an empty state), title2 22 semibold, title 17 semibold (headline), body 17/22,
 * callout 16/21, subhead/small 15/20, footnote 13/18, label 13 semibold, caption 12/16 (iOS HIG sizes;
 * Material 3 on Android). All in the system font, so titles sit with the rest of the OS.
 */
export function variantStyle(variant: TextVariant): TextStyle {
  const [style, weight] = VARIANT_STYLE[variant];
  return systemText(style, weight);
}

/** Variants that are chrome (timestamps, meta) or already big grow less with the text size setting. */
const MAX_SCALE: Partial<Record<TextVariant, number>> = {
  display: CHROME_MAX_SCALE,
  display2: CHROME_MAX_SCALE,
  caption: CHROME_MAX_SCALE,
};

/**
 * One line of a variant on screen, grown with the text size setting as far as the variant grows: its height
 * and where the eye reads it (`readingMiddle`). `metrics`: the text's own size when it sets one over its
 * variant (e.g. `LIST_PREVIEW`).
 */
export function textLineOf(
  variant: TextVariant,
  fontScale: number,
  metrics?: { fontSize?: number; lineHeight?: number },
): { height: number; middle: number } {
  const base = variantStyle(variant);
  const max = MAX_SCALE[variant];
  const k = max ? Math.min(fontScale, max) : fontScale;
  const fontSize = (metrics?.fontSize ?? base.fontSize ?? 17) * k;
  const height = (metrics?.lineHeight ?? base.lineHeight ?? 22) * k;
  return { height, middle: readingMiddle(fontSize, height) };
}

/** Text in the design system's scale and tones. Names stay in ink; counts use `Count`. */
export function Text({ variant = "body", tone, style, maxFontSizeMultiplier, ...rest }: TextProps) {
  const { colors } = useTheme();
  const color = colors[tone ?? DEFAULT_TONE[variant]];
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? MAX_SCALE[variant]}
      style={[variantStyle(variant), { color }, style]}
    />
  );
}
