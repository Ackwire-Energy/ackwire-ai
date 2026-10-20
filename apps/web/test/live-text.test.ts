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

  test("a trailing blank line (nothing after it yet): one block, so the caret has text", () => {
    const text = "Um.\n\nDois.\n\n";
    expect(splitSettled(text)).toEqual({ settled: "", tail: text });
  });

  test("a list keeps growing in the tail", () => {
    expect(splitSettled("Passos:\n\n- um\n- dois")).toEqual({ settled: "Passos:", tail: "- um\n- dois" });
  });
});
