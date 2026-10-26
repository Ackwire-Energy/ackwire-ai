import { describe, expect, test } from "bun:test";
import { type CodeToken, codeLabel, highlightCode } from "../src/lib/code";

const kinds = (line: CodeToken[] | undefined, kind: CodeToken["kind"]) =>
  (line ?? []).filter((t) => t.kind === kind).map((t) => t.text.trim());

describe("codeLabel", () => {
  test("known languages by their name, unknown as written, none as empty", () => {
    expect(codeLabel("ts")).toBe("TypeScript");
    expect(codeLabel("SQL")).toBe("SQL");
    expect(codeLabel("bash")).toBe("Bash");
    expect(codeLabel("elixir")).toBe("elixir");
    expect(codeLabel("")).toBe("");
  });
});

describe("highlightCode", () => {
  test("every line comes back, and joining the tokens gives the code back unchanged", () => {
    const code = "const a = 'x'; // note\n\nfoo(1.5, \"y\")";
    const lines = highlightCode(code, "ts");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.map((t) => t.text).join("")).join("\n")).toBe(code);
  });

  test("keywords, strings, numbers, calls and line comments", () => {
    const [line] = highlightCode("const total = sum(items, 42) // all of them", "js");
    expect(kinds(line, "keyword")).toEqual(["const"]);
    expect(kinds(line, "function")).toEqual(["sum"]);
    expect(kinds(line, "number")).toEqual(["42"]);
    expect(kinds(line, "comment")).toEqual(["// all of them"]);
  });

  test("SQL keywords in any case; -- comments; strings with spaces", () => {
    const lines = highlightCode("-- signups\nSELECT count(*) FROM users WHERE at >= now() - interval '7 days'", "sql");
    expect(kinds(lines[0], "comment")).toEqual(["-- signups"]);
    expect(kinds(lines[1], "keyword")).toEqual(["SELECT", "FROM", "WHERE", "interval"]);
    expect(kinds(lines[1], "string")).toEqual(["'7 days'"]);
    expect(kinds(lines[1], "function")).toEqual(["count", "now"]);
  });

  test("a block comment carries across lines", () => {
    const lines = highlightCode("a /* one\ntwo\nthree */ b", "ts");
    expect(kinds(lines[0], "comment")).toEqual(["/* one"]);
    expect(kinds(lines[1], "comment")).toEqual(["two"]);
    expect(kinds(lines[2], "comment")).toEqual(["three */"]);
    expect(kinds(lines[2], "plain").join("")).toBe("b");
  });

  test("shell: # starts a comment only after a space ($# is not one)", () => {
    const [line] = highlightCode('echo "$#" args # count', "bash");
    expect(kinds(line, "comment")).toEqual(["# count"]);
    expect(kinds(line, "keyword")).toEqual(["echo"]);
  });

  test("numbers inside names are not numbers; escaped quotes stay in the string", () => {
    const [line] = highlightCode("v2 = 'it\\'s'", "py");
    expect(kinds(line, "number")).toEqual([]);
    expect(kinds(line, "string")).toEqual(["'it\\'s'"]);
  });

  test("diff lines are added or removed whole", () => {
    const lines = highlightCode("@@ -1 +1 @@\n-old\n+new\n same", "diff");
    expect(lines.map((l) => l[0]?.kind)).toEqual(["comment", "deleted", "inserted", "plain"]);
  });

  test("no language: plain text, nothing colored", () => {
    const lines = highlightCode("if this then that 42", "");
    expect(lines).toEqual([[{ kind: "plain", text: "if this then that 42" }]]);
  });
});
