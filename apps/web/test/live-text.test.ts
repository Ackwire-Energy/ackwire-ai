import { describe, expect, test } from "bun:test";
import { splitSettled } from "@/chat/live-text";

describe("splitSettled: done blocks vs the one still growing", () => {
  test("paragraphs: the last blank line splits", () => {
    expect(splitSettled("Primeiro.\n\nSegundo.\n\nTerceiro em curso")).toEqual({
      settled: "Primeiro.\n\nSegundo.",
      tail: "Terceiro em curso",
    });
  });

  test("blank lines with spaces count as boundaries", () => {
    expect(splitSettled("Um.\n   \nDois")).toEqual({ settled: "Um.", tail: "Dois" });
  });

  test("no boundary: everything is the tail", () => {
    expect(splitSettled("Só uma frase")).toEqual({ settled: "", tail: "Só uma frase" });
    expect(splitSettled("")).toEqual({ settled: "", tail: "" });
  });

  test("a blank line inside an open code fence is not a boundary", () => {
    const text = "Antes.\n\n```ts\nconst a = 1;\n\nconst b = 2;";
    expect(splitSettled(text)).toEqual({ settled: "Antes.", tail: "```ts\nconst a = 1;\n\nconst b = 2;" });
  });

  test("after a closed fence the next blank line splits again", () => {
    const text = "```\na\n\nb\n```\n\nDepois";
    expect(splitSettled(text)).toEqual({ settled: "```\na\n\nb\n```", tail: "Depois" });
  });

  test("a trailing blank line (nothing after it yet): the split before it, so settled blocks stay and the caret has text", () => {
    expect(splitSettled("Um.\n\nDois.\n\n")).toEqual({ settled: "Um.", tail: "Dois.\n\n" });
    expect(splitSettled("Um.\n\n")).toEqual({ settled: "", tail: "Um.\n\n" });
  });

  test("a ``` line with words after it is not a fence (as the parser reads it): it doesn't close an open block", () => {
    const text = "```\na\n```js title\n\nb\n```\n\nDepois";
    expect(splitSettled(text)).toEqual({ settled: "```\na\n```js title\n\nb\n```", tail: "Depois" });
  });

  test("a list keeps growing in the tail", () => {
    expect(splitSettled("Passos:\n\n- um\n- dois")).toEqual({ settled: "Passos:", tail: "- um\n- dois" });
  });
});
