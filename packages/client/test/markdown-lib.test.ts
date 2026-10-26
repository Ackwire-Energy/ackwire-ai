import { describe, expect, test } from "bun:test";
import { parseMarkdown, tableAt } from "../src/lib/markdown";

const TABLE = [
  "| Gatilho | Exibições | Compras | Taxa |",
  "|---|---|---|---|",
  "| `first_trip_soft` | 67 | 10 | ~15% |",
  "| generic | 435 | 29 | ~6,7% |",
].join("\n");

describe("tables", () => {
  test("a table right under a sentence is still a table (not swallowed by the paragraph)", () => {
    const blocks = parseMarkdown(`Usei a semana desde 18/10:\n${TABLE}\nO primeiro converte melhor.`, { breaks: true });
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "table", "paragraph"]);
    const table = blocks[1];
    expect(table?.type === "table" && table.rows).toEqual([
      ["`first_trip_soft`", "67", "10", "~15%"],
      ["generic", "435", "29", "~6,7%"],
    ]);
  });

  test("number columns align right; the separator's colons win", () => {
    expect(tableAt(TABLE.split("\n"), 0)?.table.align).toEqual(["left", "right", "right", "right"]);
    const marked = tableAt(["| a | b | c |", "|:---:|:---|---:|", "| x | 1 | y |"], 0);
    expect(marked?.table.align).toEqual(["center", "left", "right"]);
    expect(marked?.next).toBe(3);
  });

  test("a line with pipes but no rule under it is text", () => {
    expect(tableAt(["a | b", "c | d"], 0)).toBeNull();
    expect(parseMarkdown("a | b\nc | d").map((b) => b.type)).toEqual(["paragraph"]);
  });
});
