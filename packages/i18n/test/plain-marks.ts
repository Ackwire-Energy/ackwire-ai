import { readFileSync } from "node:fs";
import { leaves } from "./leaves";
import { sourceFiles } from "./maker-words";

/**
 * Words people read use no semicolon and no em dash: two short sentences read plainer, and both marks read as
 * machine-written. A "·" separates data and never two clauses, which review checks, not this file.
 */
export const MARKS = /[;—]/;

/** Code the landing shows as code. */
const CODE_SAMPLES: ReadonlySet<string> = new Set(["landing.bento.db.read", "landing.bento.db.write"]);

/** Code keeps its marks: `code` spans, help code blocks (`….code`) and HTML entities (`&amp;`). */
const outsideCode = (text: string) => text.replace(/&#?\w+;/g, "").replace(/`[^`]*`/g, "");

/** A string tree's leaves that break the rule, as "key: text", for one readable failure. */
export const unplainLeaves = (tree: unknown) =>
  leaves(tree)
    .filter((leaf): leaf is [string, string] => typeof leaf[1] === "string")
    .filter(([key, text]) => !CODE_SAMPLES.has(key) && !key.endsWith(".code") && MARKS.test(outsideCode(text)))
    .map(([key, text]) => `${key}: ${text}`);

/** An `apiError(c, status, code, "…")`, or an engine or runner error the API answers with, up to its `(`. */
const SERVER_WORDS =
  /\b(?:apiError|new (?:Validation|Conflict|NotFound|Forbidden|TooMany|MissingCredential|Runner)Error)\(/g;

/**
 * Reads code from `i` to the bracket that closes the one just before it, and returns the index after that bracket.
 * Every string in it goes to `out`: quoted ones, and the text of template literals (their `${…}` read as code).
 */
function scanCode(src: string, i: number, out: string[]): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const close = src[i + 1] === "/" ? "\n" : "*/";
      const at = src.indexOf(close, i + 2);
      i = at < 0 ? src.length : at + close.length;
    } else if (c === '"' || c === "'") {
      let end = i + 1;
      while (end < src.length && src[end] !== c) end += src[end] === "\\" ? 2 : 1;
      out.push(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === "`") i = scanTemplate(src, i + 1, out);
    else if ("([{".includes(c)) {
      depth++;
      i++;
    } else if (")]}".includes(c) && --depth < 0) return i + 1;
    else i++;
  }
  return i;
}

function scanTemplate(src: string, i: number, out: string[]): number {
  let text = "";
  while (i < src.length) {
    if (src[i] === "\\") {
      text += src.slice(i, i + 2);
      i += 2;
    } else if (src[i] === "`") {
      out.push(text);
      return i + 1;
    } else if (src[i] === "$" && src[i + 1] === "{") {
      out.push(text);
      text = "";
      i = scanCode(src, i + 2, out);
    } else text += src[i++];
  }
  return i;
}

/**
 * The server's words for people that break the rule, as "file: text": every string in those calls' arguments, so
 * both sides of a ternary count. It reads the raw source: `withoutComments` takes a `/*` inside a string ("owner/*")
 * for a comment and drops the rest of the file.
 */
export const unplainServerWords = (dirs: string[]) =>
  dirs
    .flatMap((dir) => sourceFiles(dir))
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(SERVER_WORDS)].flatMap((m) => {
        const strings: string[] = [];
        scanCode(source, m.index + m[0].length, strings);
        return strings.filter((s) => MARKS.test(s)).map((s) => `${file}: ${s}`);
      });
    });
