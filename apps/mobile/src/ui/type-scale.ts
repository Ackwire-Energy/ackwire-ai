/**
 * The native type scale (pure: no React Native import, so it is unit-tested).
 *
 * Body and UI text use the system font (SF Pro on iOS, Roboto on Android) at the platform's own sizes:
 * Apple's HIG text styles at the default Dynamic Type size, Material 3 on Android. The brand stays in
 * a rare hero number (Doto, `Count hero`) and code (mono); large titles are the system's own (bold on iOS,
 * like Mail and Settings). Counts, badges, times and countdowns are the system font, semibold, tabular (`countStyle`).
 * Every style scales with the person's text size setting; dense chrome caps its growth with
 * `CHROME_MAX_SCALE`.
 */
export type OS = "ios" | "android";

/** System font weights (no custom family: the platform picks SF Pro / Roboto at this weight). */
export const weights = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
} as const;

export type Weight = (typeof weights)[keyof typeof weights];

export type TypeStyle =
  | "largeTitle"
  | "title1"
  | "title2"
  | "title3"
  | "headline"
  | "body"
  | "callout"
  | "subhead"
  | "footnote"
  | "caption"
  | "caption2";

export interface TypeMetrics {
  fontSize: number;
  lineHeight: number;
  fontWeight: Weight;
}

/** The most a dense piece of chrome (tab labels, chips, badges, timestamps) grows with the text size setting. */
export const CHROME_MAX_SCALE = 1.3;

const m = (fontSize: number, lineHeight: number, fontWeight: Weight = weights.regular): TypeMetrics => ({
  fontSize,
  lineHeight,
  fontWeight,
});

/** iOS: HIG text styles at the default ("Large") Dynamic Type size. */
const IOS: Record<TypeStyle, TypeMetrics> = {
  largeTitle: m(34, 41),
  title1: m(28, 34),
  title2: m(22, 28),
  title3: m(20, 25),
  headline: m(17, 22, weights.semibold),
  body: m(17, 22),
  callout: m(16, 21),
  subhead: m(15, 20),
  footnote: m(13, 18),
  caption: m(12, 16),
  caption2: m(11, 13),
};

/** Android: Material 3 (body large 16/24, body medium 14/20, title medium 16/24 medium, label/body small 12/16). */
const ANDROID: Record<TypeStyle, TypeMetrics> = {
  largeTitle: m(32, 40),
  title1: m(28, 36),
  title2: m(22, 28),
  title3: m(20, 26),
  headline: m(16, 24, weights.medium),
  body: m(16, 24),
  callout: m(15, 22),
  subhead: m(14, 20),
  footnote: m(12, 16),
  caption: m(12, 16),
  caption2: m(11, 16),
};

export function typeScale(os: OS): Record<TypeStyle, TypeMetrics> {
  return os === "android" ? ANDROID : IOS;
}

/** One style's metrics, with another weight when asked (e.g. footnote semibold for labels). */
export function typeStyle(os: OS, style: TypeStyle, fontWeight?: Weight): TypeMetrics {
  const base = typeScale(os)[style];
  return fontWeight ? { ...base, fontWeight } : base;
}

/**
 * A number in the chrome (unread badges, section counts, times, "expira em", the undo countdown): the system
 * font, semibold, tabular figures so it doesn't jump as it changes. Doto is only for a rare hero number.
 */
export function countStyle(fontSize: number, fontWeight: Weight = weights.semibold) {
  return {
    fontSize,
    lineHeight: Math.round(fontSize * 1.2),
    fontWeight,
    fontVariant: ["tabular-nums"] as ["tabular-nums"],
  };
}
