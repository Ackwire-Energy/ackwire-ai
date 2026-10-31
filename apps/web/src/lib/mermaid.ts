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
 *   Chromium 156 still opens a connection to a refused address, so the tags that navigate are left to the second layer
 *   too.
 * - The page sends `{id, source, dark}` and takes `{id, svg}` or `{id, error}` back only from the inner frame's
 *   window, so another frame on the page (an agent's HTML page) can't post a drawing. The SVG still goes into an
 *   `<img>`, where nothing in it runs or loads.
 * - Mermaid's own settings in mermaid-frame.js (strict, no HTML labels, its sanitizer) are a second layer.
 */

/** Mermaid's own `maxTextSize`: past it mermaid draws a red "Maximum text size" box instead of the diagram. */
export const MERMAID_MAX_TEXT = 50_000;
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
  el.srcdoc = mermaidFrameDocument([mermaidBundle, frameScript].map((url) => new URL(url, document.baseURI).href));
  const loaded = new Promise((resolve) => el.addEventListener("load", resolve, { once: true }));
  document.body.append(el);
  return { window: () => el.contentWindow?.[0], loaded, remove: () => el.remove() };
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
