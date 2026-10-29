import { join } from "node:path";
import { build } from "vite";

const WEB = join(import.meta.dir, "..");

/**
 * A stylesheet as the production build writes it, the app's own unless `input` names another (a component's, from
 * apps/web): Vite's own CSS pipeline (its minifier and targets).
 */
export async function builtCss(input = "src/styles.css") {
  const out = await build({
    configFile: false,
    logLevel: "silent",
    root: WEB,
    build: { write: false, rollupOptions: { input: join(WEB, input) } },
  });
  return (Array.isArray(out) ? out : [out])
    .flatMap((o) => ("output" in o ? o.output : []))
    .flatMap((o) => (o.type === "asset" && o.fileName.endsWith(".css") ? [String(o.source)] : []))
    .join("\n");
}

/** A stylesheet without its comments and its at-rule blocks (`@media`, `@supports`…): what applies at every width. */
export function topLevel(css: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") {
      out += text[i];
      continue;
    }
    const open = text.indexOf("{", i);
    const semi = text.indexOf(";", i);
    if (open < 0 || (semi >= 0 && semi < open)) {
      i = semi < 0 ? text.length : semi;
      continue;
    }
    let depth = 0;
    for (i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) break;
    }
  }
  return out;
}

/** A media query as the minifier writes it: `(max-width: 720px)` as `(width<=720px)`, spaces out. */
const mediaQuery = (query: string) =>
  query
    .replace(/\(\s*max-width\s*:\s*([\d.]+px)\s*\)/g, "(width<=$1)")
    .replace(/\(\s*min-width\s*:\s*([\d.]+px)\s*\)/g, "(width>=$1)")
    .replace(/\s+/g, "")
    .toLowerCase();

/** The rules of every `@media` block whose query is `media`, however it is written, as one sheet. */
export function atMedia(css: string, media: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const wanted = mediaQuery(media);
  let out = "";
  for (let at = text.indexOf("@media"); at >= 0; at = text.indexOf("@media", at + 1)) {
    const open = text.indexOf("{", at);
    if (mediaQuery(text.slice(at + "@media".length, open)) !== wanted) continue;
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}" && --depth === 0) break;
    }
    out += `${text.slice(open + 1, end)}\n`;
  }
  return out;
}

const normal = (selector: string) =>
  selector
    .replace(/\s*([>+~,()])\s*/g, "$1")
    .replace(/="([^"]*)"/g, "=$1")
    .replace(/\s+/g, " ")
    .trim();

/** The declarations of every rule whose selector list holds `selector`, in order, as [property, value]. */
export function declarations(css: string, selector: string) {
  const wanted = normal(selector);
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => splitList(normal(m[1] ?? "")).includes(wanted))
    .flatMap((m) =>
      (m[2] ?? "")
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()] as const),
    );
}

/** A selector list's selectors, split on its top-level commas only (`:is(a, b)` stays one). */
function splitList(list: string) {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, list.slice(start)];
}
