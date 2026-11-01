import { escapeHtml } from "@agenteschat/client/lib/text";
import mermaidBundle from "mermaid/dist/mermaid.min.js?url&no-inline";
import frameScript from "./mermaid-frame.js?url&no-inline";

/**
 * Mermaid draws in the document it runs in, and a diagram has many ways to make that document load a URL while it
 * draws (an image node, CSS url() through classDef, style or its own settings, label HTML, a sequence actor's icon…).
 * In the page, each would reach the network from every viewer's browser with no click: who read it, when, and whatever
 * an agent put in the URL. So mermaid runs in a frame where nothing loads, whatever the diagram says:
 *
 * - An iframe sandboxed with `allow-scripts` only (an opaque origin: no cookies, storage or DOM of ours) holds a second
 *   one, sandboxed the same way, where mermaid draws. Both carry the CSP of `mermaidFrameDocument`: nothing loads but
 *   mermaid's bundle and mermaid-frame.js, plus inline styles and data: images. The outer one's `default-src 'none'`
 *   is also the inner one's frame-src, which refuses the inner frame navigating itself away (a `<meta
 *   http-equiv="refresh">`): CSP has no other say over a document's own navigations, and the sandbox allows them.
 *   Chromium 156 still opens a connection to a refused address, and preconnects and looks up `<link rel=preconnect>`
 *   and `dns-prefetch` hosts whatever the CSP says, so the tags that navigate and `<link>` are left to the second layer.
 * - The page sends `{id, source, dark}` and takes `{id, svg}` or `{id, error}` back only from the inner frame's
 *   window, so another frame on the page (an agent's HTML page) can't post a drawing. The SVG still goes into an
 *   `<img>`, where nothing in it runs or loads.
 * - Mermaid's own settings in mermaid-frame.js (strict, no HTML labels, its sanitizer) are a second layer.
 *
 * Desktop Chrome and Edge give the frame a process of its own, where a drawing that takes long only holds up the next
 * one. Safari, Firefox and the desktop app (WebKit) run the frame on the page's own thread: there every drawing holds
 * up the page, and the timeout below can't fire until mermaid lets go. `mermaidDrawable` bounds what goes to mermaid
 * and says what a drawing within the bounds still costs.
 */

const MERMAID_MAX_TEXT = 5000;
const MERMAID_MAX_LINES = 200;
const MERMAID_MAX_LINE = 500;
const MERMAID_MAX_MINDMAP_LINES = 100;
/** A venn diagram's `set` and `union` lines. */
const MERMAID_MAX_VENN_AREAS = 30;
/** Characters mermaid's entity regexes may read over the `style` and `classDef` lines: about 25 ms of them. */
const MERMAID_MAX_STYLE_WORK = 100_000_000;
/** Mermaid's directive regex, as 11.17.2 has it: the source its parsers read is the one without these. */
const MERMAID_DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;
/** A YAML anchor (`&a`) or alias (`*a`): an `&` or `*` that starts a key or a value and names something. */
const YAML_ANCHOR_OR_ALIAS = /(?:^|[\s:?,[{-])[&*]\S/;

/**
 * Whether a source goes to mermaid, checked before anything reaches the frame, in time linear in the source. Safari,
 * Firefox and the desktop app wait out every drawing on the page's thread, and past these bounds one fence held
 * WebKit 26 or Firefox 144 for seconds:
 *
 * - At most 5,000 characters, 200 lines and 500 characters a line. Some of mermaid's parsers take time that grows with
 *   the square of the source (50,000 characters of `;` in an xychart: 5 s, 4,800 lines of `<a` in an architecture
 *   diagram: 4.7 s), and some of its layouts a millisecond or more a node.
 * - At most 100 lines in a mindmap, and 30 sets and unions in a venn diagram: their layouts grow much faster than their
 *   size (a mindmap of 1,000 nodes: 21 s, a venn diagram of 200 sets: 100 s).
 * - No more `style` and `classDef` than mermaid's entity regexes read in a moment. `style.*:\S*#.*;` (the same with
 *   classDef) tries, on a line with no `;` after its last `#`, each style there with each `:` after it and each `#`
 *   after that, reading the rest of the line each time.
 * - Front matter that mermaid reads, without YAML anchors or aliases: mermaid walks the config as a tree, so aliases of
 *   aliases take it exponential time (437 characters: 13 s).
 *
 * What's left is what drawing a big diagram costs. The slowest fence measured within the bounds, a block diagram that
 * packs 1,000 blocks into 5,000 characters, holds the page 1.4 s in WebKit and 1.3 s in Firefox, and the largest of
 * every other kind tried less than 0.8 s. Chrome and Edge on a desktop draw in the frame's own process instead.
 */
export function mermaidDrawable(source: string): boolean {
  if (source.length > MERMAID_MAX_TEXT) return false;
  const lines = source.split(/\r\n?|\n/);
  if (lines.length > MERMAID_MAX_LINES || lines.some((line) => line.length > MERMAID_MAX_LINE)) return false;
  // Front matter ends at a `---` line in the opening one's indent, from the third line on and followed by a line break
  // (mermaid's regex, once mermaid has made every `\r\n` a `\n`). Without one mermaid refuses the diagram.
  let body = lines;
  const first = lines[0] ?? "";
  if (first.trim() === "---") {
    const closing = `${first.slice(0, first.indexOf("-"))}---`;
    const end = lines.findIndex(
      (line, i) => i >= 2 && i < lines.length - 1 && line.startsWith(closing) && !line.slice(closing.length).trim(),
    );
    if (end < 0 || YAML_ANCHOR_OR_ALIAS.test(lines.slice(1, end).join("\n"))) return false;
    body = lines.slice(end + 1);
  }
  // What mermaid's parsers read: the rest without its directives, which can join the lines around them into one.
  const text = body.join("\n").replace(MERMAID_DIRECTIVE, "");
  const read = text.split("\n");
  let styleWork = 0;
  for (const line of read) {
    if (line.length > MERMAID_MAX_LINE) return false;
    const styles = line.match(/style|classDef/g)?.length ?? 0;
    styleWork += styles * line.split(":").length * line.split("#").length * line.length;
  }
  if (styleWork > MERMAID_MAX_STYLE_WORK) return false;
  if (/^\s*mindmap/m.test(text) && read.length > MERMAID_MAX_MINDMAP_LINES) return false;
  return !/^\s*venn-beta/m.test(text) || (text.match(/^\s*(?:set|union)\b/gim)?.length ?? 0) <= MERMAID_MAX_VENN_AREAS;
}

/** Both frames' sandbox. Not the agent pages' (HtmlFrame): what those may be allowed must never reach this one. */
const SANDBOX = "allow-scripts";

/** The frame mermaid draws in: the window that answers, its load (done or failed) and its removal. */
export type MermaidFrame = { window: () => Window | null | undefined; loaded: Promise<unknown>; remove: () => void };

/**
 * The outer frame's document, with the inner one where mermaid draws. `scripts`: the absolute addresses of mermaid's
 * bundle and mermaid-frame.js, the only scripts it may run (an opaque origin has no 'self' to name them by).
 */
export function mermaidFrameDocument(scripts: string[]): string {
  const head = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scripts.join(" ")}; style-src 'unsafe-inline'; img-src data:">`;
  const drawing = head + scripts.map((src) => `<script src="${src}"></script>`).join("");
  // The same size on every device, so every viewer gets the same drawing.
  return `${head}<iframe sandbox="${SANDBOX}" width="1280" height="900" srcdoc="${escapeHtml(drawing)}"></iframe>`;
}

function sandboxFrame(): MermaidFrame {
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", SANDBOX);
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  // Off screen but laid out (not display: none): mermaid measures its text.
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0";
  // The price of the opaque origin: Chrome never takes such a frame's scripts from its cache, so each frame (one per
  // page load, a fresh one after a timeout) downloads mermaid's bundle again. Safari and Firefox take it from theirs.
  el.srcdoc = mermaidFrameDocument([mermaidBundle, frameScript].map((url) => new URL(url, document.baseURI).href));
  const loaded = new Promise((resolve) => el.addEventListener("load", resolve, { once: true }));
  document.body.append(el);
  const inner = () => {
    // Until the outer frame has parsed the inner one, reading its first child is a cross-origin access, which throws.
    try {
      return el.contentWindow?.[0];
    } catch {
      return undefined;
    }
  };
  return { window: inner, loaded, remove: () => el.remove() };
}

let makeFrame = sandboxFrame;
let frame: { host: MermaidFrame; ready: Promise<void>; markReady: () => void } | null = null;
const waiting = new Map<string, { resolve: (svg: string) => void; reject: (error: Error) => void }>();

/** The frame's answers: only from its window, only in the protocol's shape. */
function onAnswer({ source, data }: MessageEvent) {
  if (!frame || source !== frame.host.window()) return;
  if (data?.ready === true) frame.markReady();
  const asked = typeof data?.id === "string" ? waiting.get(data.id) : undefined;
  if (typeof data?.svg === "string") asked?.resolve(data.svg);
  else if (typeof data?.error === "string") asked?.reject(new Error(data.error));
}

function currentFrame() {
  if (!frame) {
    window.addEventListener("message", onAnswer);
    let markReady = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    frame = { host: makeFrame(), ready, markReady };
  }
  return frame;
}

/**
 * Mermaid's SVG for a source, drawn in the frame (made on first use and kept). It fails when mermaid can't draw the
 * source, or hasn't answered `timeout` ms after the frame loaded: that frame is thrown away with whatever holds it up,
 * and the next drawing gets a fresh one.
 */
export async function drawWithMermaid(id: string, source: string, dark: boolean, timeout = 10_000) {
  const used = currentFrame();
  // Counted from here, however long mermaid's bundle took to arrive.
  await used.host.loaded;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      timer = setTimeout(() => {
        if (frame === used) {
          used.host.remove();
          frame = null;
        }
        reject(new Error("Mermaid didn't finish drawing"));
      }, timeout);
      used.ready.then(() => used.host.window()?.postMessage({ id, source, dark }, "*"));
    });
  } finally {
    clearTimeout(timer);
    waiting.delete(id);
  }
}

/** Tests: the frame to draw in (a fake that answers like mermaid-frame.js), or null for the real one. */
export function setMermaidFrame(next: (() => MermaidFrame) | null) {
  frame?.host.remove();
  frame = null;
  makeFrame = next ?? sandboxFrame;
}

/**
 * A diagram drawn: its image (data URL), its own width in CSS pixels (null when its SVG doesn't say) and, when the
 * diagram has them, its accTitle and accDescr.
 */
export type Drawing = { src: string; width: number | null; title?: string; description?: string };

/** Mermaid's SVG as an image at its own size, its accessible name and description taken out for the <img>. */
export function svgDrawing(svg: string): Drawing {
  // DOMParser's document never loads anything.
  const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
  // Its own size, not its box's width (mermaid's "100%"): a small diagram isn't blown up to fill the box.
  const [, , width, height] =
    root
      ?.getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  const own = width && height ? svg.replace('width="100%"', `width="${width}" height="${height}"`) : svg;
  // Mermaid writes accTitle and accDescr as the SVG's first <title> and <desc>, which an <img> hides from assistive
  // technology.
  const childText = (tag: string) =>
    Array.from(root?.children ?? [])
      .find((el) => el.localName === tag)
      ?.textContent?.trim() || undefined;
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(own)}`,
    width: width || null,
    title: childText("title"),
    description: childText("desc"),
  };
}
