import { describe, expect, test } from "bun:test";
import { MARKDOWN_HOLD_MAX, revealStep, wholeMarkdown } from "../src/lib/reveal";

describe("streamed Markdown shows whole", () => {
  test("a piece whose closing already arrived shows whole, never a raw mark", () => {
    const bold = "Veja **o resumo do mês** e depois";
    expect(bold.slice(0, wholeMarkdown(bold, 9))).toBe("Veja **o resumo do mês** ");
    const code = "Rode `bun test arquivo.ts` agora";
    expect(code.slice(0, wholeMarkdown(code, 10))).toBe("Rode `bun test arquivo.ts` ");
    const link = "Abri [o Booking](https://booking.com/x) para sexta";
    expect(link.slice(0, wholeMarkdown(link, 8))).toBe("Abri [o Booking](https://booking.com/x) ");
  });

  test("a piece still arriving waits at its opening", () => {
    const text = "Veja **o resumo do";
    expect(wholeMarkdown(text, 9)).toBe(5);
    // Nothing more this frame: the rest waits for its closing.
    expect(revealStep(5, text, 16)).toBe(5);
  });

  test("text that only looks like Markdown is text", () => {
    expect(wholeMarkdown("5 * 3 = 15 e pronto", 4)).toBe(4);
    expect(wholeMarkdown("* item um\n* item dois", 4)).toBe(4);
    expect(wholeMarkdown("snake_case e mais", 6)).toBe(6);
    // Inside a fenced block a backtick is code: the block shows line by line.
    expect(wholeMarkdown("```\nconst a = `x\n```", 12)).toBe(12);
  });

  test("a mark open too long is text, and a stopped text never waits", () => {
    const long = `**${"a ".repeat(MARKDOWN_HOLD_MAX)}`;
    expect(wholeMarkdown(long, MARKDOWN_HOLD_MAX + 10)).toBe(MARKDOWN_HOLD_MAX + 10);
    expect(revealStep(5, "Veja **o resumo do", 16, false)).toBeGreaterThan(5);
  });
});
