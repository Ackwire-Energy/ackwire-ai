import { describe, expect, test } from "bun:test";

const read = (file: string) => Bun.file(new URL(`../../src/features/${file}`, import.meta.url).pathname).text();
const style = (src: string, name: string) => src.match(new RegExp(`\\n  ${name}: \\{([^}]*)\\}`))?.[1] ?? "";

describe("an agent's answer choices grow with their text and wrap", () => {
  test("the island: a chip has a min height, never a fixed one, and its words shrink to wrap", async () => {
    const src = await read("island/NoticeIsland.tsx");
    const chip = style(src, "chip");
    expect(chip).not.toMatch(/(^|[\s,{])height:/);
    expect(chip).toContain("minHeight: 36");
    expect(chip).toContain("paddingVertical");
    expect(chip).toContain('maxWidth: "100%"');
    expect(style(src, "chipText")).toContain("flexShrink: 1");
  });

  test("the island: open, it stops above the screen's bottom and scrolls inside", async () => {
    const src = await read("island/NoticeIsland.tsx");
    expect(src).toContain("h: Math.min(openHeight, openMax)");
    expect(src).toMatch(/<ScrollView scrollEnabled=\{scrolls\}/);
  });

  test("the conversation's question card: each choice a row that grows, its words shrink to wrap", async () => {
    const src = await read("chat/cards.tsx");
    const opt = style(src, "opt");
    expect(opt).not.toMatch(/(^|[\s,{])height:/);
    expect(opt).toContain("minHeight");
    expect(style(src, "optText")).toContain("flexShrink: 1");
  });
});
