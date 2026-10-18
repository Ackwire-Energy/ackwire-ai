import { describe, expect, test } from "bun:test";
import { CHROME_MAX_SCALE, type TypeStyle, typeScale, typeStyle, weights } from "../src/ui/type-scale";

const STYLES: TypeStyle[] = [
  "largeTitle",
  "title2",
  "title3",
  "headline",
  "body",
  "callout",
  "subhead",
  "footnote",
  "caption",
  "caption2",
];

describe("native type scale", () => {
  test("iOS follows the HIG text styles at the default Dynamic Type size", () => {
    const ios = typeScale("ios");
    const sizes = Object.fromEntries(STYLES.map((s) => [s, [ios[s].fontSize, ios[s].lineHeight]]));
    expect(sizes).toEqual({
      largeTitle: [34, 41],
      title2: [22, 28],
      title3: [20, 25],
      headline: [17, 22],
      body: [17, 22],
      callout: [16, 21],
      subhead: [15, 20],
      footnote: [13, 18],
      caption: [12, 16],
      caption2: [11, 13],
    });
    expect(ios.headline.fontWeight).toBe(weights.semibold);
    expect(ios.body.fontWeight).toBe(weights.regular);
  });

  test("Android follows Material 3: body 16/24, title medium", () => {
    const android = typeScale("android");
    expect(android.body).toEqual({ fontSize: 16, lineHeight: 24, fontWeight: weights.regular });
    expect(android.subhead).toEqual({ fontSize: 14, lineHeight: 20, fontWeight: weights.regular });
    expect(android.headline.fontWeight).toBe(weights.medium);
  });

  test("every style leaves room for its glyphs and steps down in size", () => {
    for (const os of ["ios", "android"] as const) {
      const scale = typeScale(os);
      for (const s of STYLES) expect(scale[s].lineHeight).toBeGreaterThanOrEqual(scale[s].fontSize);
      const order: TypeStyle[] = [
        "largeTitle",
        "title2",
        "title3",
        "body",
        "callout",
        "subhead",
        "caption",
        "caption2",
      ];
      for (let i = 1; i < order.length; i++)
        expect(scale[order[i] as TypeStyle].fontSize).toBeLessThanOrEqual(scale[order[i - 1] as TypeStyle].fontSize);
    }
  });

  test("a weight override keeps the size (labels: footnote semibold)", () => {
    expect(typeStyle("ios", "footnote", weights.semibold)).toEqual({
      fontSize: 13,
      lineHeight: 18,
      fontWeight: weights.semibold,
    });
    expect(typeStyle("ios", "footnote")).toBe(typeScale("ios").footnote);
  });

  test("dense chrome grows, but less than body text", () => {
    expect(CHROME_MAX_SCALE).toBeGreaterThan(1);
    expect(CHROME_MAX_SCALE).toBeLessThanOrEqual(1.5);
  });
});
