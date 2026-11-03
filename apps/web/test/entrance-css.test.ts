import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

// A password manager placing its icon in a field sets `animation: none !important` on the field's container and then
// removes it (Proton Pass), which replays a keyframe entrance there on every keystroke that empties or fills the
// field. The entrances run as transitions from `@starting-style` instead: once, when the step is inserted.
test.each([
  ["src/components/auth.css", [".auth__bubble", ".auth__step", ".auth__fix"]],
  ["src/pages/onboarding.css", [".onb__body", ".onb__bubble", ".onb__answer", ".onb__actions"]],
])(
  "%s: each step's entrance plays once, from its starting style, never as a keyframe animation",
  async (file, selectors) => {
    const css = await builtCss(file);
    for (const selector of selectors) {
      const own = declarations(topLevel(css), selector);
      expect(own.filter(([p]) => p.startsWith("animation"))).toEqual([]);
      expect(own.some(([p, v]) => p === "transition" && v.includes("opacity"))).toBe(true);
      expect(declarations(atRule(css, "@starting-style"), selector)).toContainEqual(["opacity", "0"]);
    }
  },
);
