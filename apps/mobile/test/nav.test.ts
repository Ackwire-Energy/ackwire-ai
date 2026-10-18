import { describe, expect, test } from "bun:test";
import { needsHeaderBlur, tabBadge } from "../src/lib/nav";
import { iconSvg } from "../src/ui/iconSvg";
import { ICON_NAMES } from "../src/ui/icons.data";

describe("native navigation helpers", () => {
  test("tab badge: hidden at zero, the count, then 99+", () => {
    expect(tabBadge(0)).toBeUndefined();
    expect(tabBadge(-3)).toBeUndefined();
    expect(tabBadge(Number.NaN)).toBeUndefined();
    expect(tabBadge(1)).toBe("1");
    expect(tabBadge(99)).toBe("99");
    expect(tabBadge(100)).toBe("99+");
  });

  test("header blur only on iOS before Liquid Glass (26)", () => {
    expect(needsHeaderBlur("ios", "18.4")).toBe(true);
    expect(needsHeaderBlur("ios", "26.0")).toBe(false);
    expect(needsHeaderBlur("ios", "27.1")).toBe(false);
    expect(needsHeaderBlur("android", 35)).toBe(false);
    expect(needsHeaderBlur("ios", "unknown")).toBe(false);
  });
});

describe("icon as SVG (Android tab bar icons)", () => {
  test("every icon becomes a 24×24 SVG in the given color", () => {
    for (const name of ICON_NAMES) {
      const svg = iconSvg(name, "#fff");
      expect(
        svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'),
      ).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain("#fff");
    }
  });

  test("same geometry as Icon: stroke 1.7, round caps, filled dots", () => {
    expect(iconSvg("back", "white")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
        '<path d="m15 5-7 7 7 7" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
        "</svg>",
    );
    expect(iconSvg("more", "red")).toContain('<circle cx="6" cy="12" r="1.3" fill="red"/>');
    expect(iconSvg("search", "red")).toContain(
      '<circle cx="11" cy="11" r="6.5" fill="none" stroke="red" stroke-width="1.7"/>',
    );
  });
});
