import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dayInView } from "../../src/features/chat/logic";
import { appColors, toastGlow, toastToneOf, toneColor, withAlpha } from "../../src/ui/palette";
import { message } from "./fixtures";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe("the floating date while the conversation scrolls", () => {
  test("the day of the topmost row in view that has one: a day line, else a message", () => {
    const m = message({ id: "a", createdAt: "2026-10-30T12:00:00.000Z" });
    expect(
      dayInView([
        { index: 4, item: { kind: "message", message: m } },
        { index: 3, item: { kind: "unseen" } },
        { index: 5, item: { kind: "day", iso: "2026-10-31T00:00:00.000Z" } },
      ]),
    ).toBe("2026-10-30T12:00:00.000Z");
    expect(dayInView([{ index: 2, item: { kind: "day", iso: "2026-10-29T00:00:00.000Z" } }])).toBe(
      "2026-10-29T00:00:00.000Z",
    );
    expect(dayInView([{ index: 0, item: { kind: "run" } }])).toBeNull();
    expect(dayInView([])).toBeNull();
  });

  test("it shows while the person drags or flings the list and fades a moment after it stops", () => {
    const screen = src("features/chat/ChatScreen.tsx");
    expect(screen).toMatch(/onScrollBeginDrag=\{\(\) => \{\s*dragging\.current = true;\s*showDay\(\);/);
    expect(screen).toContain("onMomentumScrollBegin={showDay}");
    expect(screen).toMatch(/onMomentumScrollEnd=\{\(\) => \{\s*releaseAtEnd\(\);\s*hideDay\(\);/);
    expect(screen).toContain("setTopDay(dayInView(viewableItems))");
    // The person's locale: the shared day words ("Hoje", "Ontem", a weekday this week, else a date).
    expect(src("features/chat/DatePill.tsx")).toContain('dayLabel(t, i18n.language || "en", day)');
  });
});

describe("toasts glow in their tone, as the web's", () => {
  test("a failure is danger, a done check success, any other icon neutral; a tone given wins", () => {
    expect(toastToneOf("x")).toBe("danger");
    expect(toastToneOf("alert")).toBe("danger");
    expect(toastToneOf(undefined)).toBe("success");
    expect(toastToneOf("check")).toBe("success");
    expect(toastToneOf("copy")).toBe("neutral");
    expect(src("ui/Toast.tsx")).toContain("item.tone ?? toastToneOf(item.icon)");
  });

  test("the glow is the tone's color from the right, 24% in light and 30% in dark, clear over the left 55%", () => {
    for (const scheme of ["light", "dark"] as const) {
      const colors = appColors(scheme);
      const end = scheme === "dark" ? "4d" : "3d";
      expect(toastGlow(colors, "success", scheme).colors).toEqual([
        withAlpha(colors.ok, 0),
        withAlpha(colors.ok, 0),
        `${colors.ok.slice(0, 7)}${end}`,
      ]);
      expect(toastGlow(colors, "info", scheme).colors[2]).toBe(withAlpha(colors.agent, scheme === "dark" ? 0.3 : 0.24));
      expect(toastGlow(colors, "warning", scheme).colors[2]).toBe(
        withAlpha(colors.warn, scheme === "dark" ? 0.3 : 0.24),
      );
      expect(toastGlow(colors, "danger", scheme).colors[2]).toBe(
        withAlpha(colors.danger, scheme === "dark" ? 0.3 : 0.24),
      );
      expect(toastGlow(colors, "neutral", scheme).colors[2]).toBe(
        withAlpha(colors.faint, scheme === "dark" ? 0.3 : 0.24),
      );
      expect(toastGlow(colors, "info", scheme).locations).toEqual([0, 0.55, 1]);
      expect(toneColor(colors, "danger")).toBe(colors.danger);
    }
  });
});

describe("nobody will answer: the receipt's sheet, never a line", () => {
  test("the sheet says it and offers each agent it reached to call, with its @handle put in the box", () => {
    const receipts = src("features/chat/AgentReceipts.tsx");
    expect(receipts).toContain('t(mentionNeeded ? "receipts.mentionNeeded" : "receipts.nobody")');
    expect(receipts).toContain('<SectionHeader title={t("channel.callAgent")} />');
    expect(receipts).toMatch(/requestComposerText\(m\.channelId, `@\$\{c\.handle\} `\)/);
    // The marks are the clock, one tick and two.
    expect(receipts).toMatch(/if \(mark === "none"\) return null;\s*return <Icon name=\{mark\}/);
  });
});
