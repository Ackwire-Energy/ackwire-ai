import { readFileSync } from "node:fs";
import { sourceFiles } from "./maker-words";

/**
 * Words people read use no semicolon and no em dash: two short sentences read plainer, and both marks read as
 * machine-written.
 */
const MARKS = /[;—]/;

/** The message of an `apiError(c, status, code, "…")`, or of an engine error the API answers with. */
const SERVER_WORDS = [
  /\bapiError\(\s*\w+,\s*\d+,\s*"[^"]*",\s*(["`])((?:(?!\1)[^\\]|\\.)*)\1/g,
  /\bnew (?:Validation|Conflict|NotFound|Forbidden|TooMany|MissingCredential)Error\(\s*(["`])((?:(?!\1)[^\\]|\\.)*)\1/g,
];

/**
 * The server's words for people that break the rule, as "file: text". It reads the raw source: `withoutComments`
 * takes a `/*` inside a string ("owner/*") for a comment and drops the rest of the file.
 */
export const unplainServerWords = (dirs: string[]) =>
  dirs
    .flatMap((dir) => sourceFiles(dir))
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return SERVER_WORDS.flatMap((re) => [...source.matchAll(re)])
        .filter((m) => MARKS.test(m[2] ?? ""))
        .map((m) => `${file}: ${m[2]}`);
    });
