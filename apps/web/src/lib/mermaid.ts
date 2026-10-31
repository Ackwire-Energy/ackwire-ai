/**
 * Mermaid draws in the page itself (the SVG becomes an inert <img> only afterwards), so anything in a diagram that
 * makes the page load a URL while it draws reaches the network from every viewer's browser, no click needed: who
 * read it, when, and whatever text an agent put in the URL. Checked against mermaid 11.17.2, these are the ways a
 * source can do that, and a source that uses any of them stays code:
 *
 * - Settings: `%%{init}%%` / `%%{initialize}%%` directives and front matter `config` reach the page's CSS
 *   (themeCSS, themeVariables, fontFamily). Front matter may only hold a `title`.
 * - A flowchart image node (`A@{ img: "…" }`): mermaid loads it with `new Image()` before any SVG exists. The YAML key
 *   can be spelled with escapes (`"\x69mg"`), so in a source with shape data any backslash counts too.
 * - A sequence actor's `properties` (an icon drawn as an <image>) and `details` (JSON read from an element of the page).
 * - CSS that loads (`url(`, `image-set("…")`, `@import`…) in classDef, style, linkStyle, a gantt todayMarker: CSS
 *   escapes are read first (`\75 rl(` is `url(`).
 * - An HTML tag with an attribute (`<img src=…>`): math labels, architecture icons and event modeling boxes put label
 *   HTML in the page even with HTML labels off.
 */

/** Mermaid's own `maxTextSize`: past it mermaid draws a red "Maximum text size" box instead of the diagram. */
const MAX_TEXT = 50_000;
/** Front matter where mermaid finds it: YAML between `---` lines at the very top (mermaid's own pattern). */
const FRONT_MATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s;
const TITLE_LINE = /^\s*title\s*:/;
const CSS_LOAD = /(?:url|image(?:-set)?|src)\s*\(|@import/i;
const CSS_ESCAPE = /\\(?:([\da-f]{1,6})\s?|([^\n]))/gi;
const TAG_WITH_ATTRIBUTE = /<[a-z][^\s/>]*[\s/]+[^\s/>=]+\s*=/i;
const ACTOR_MENU = /(?:^|[\n;])\s*(?:properties|details)\b/i;

const cssUnescaped = (text: string) =>
  text.replace(CSS_ESCAPE, (_, hex: string | undefined, char: string | undefined) =>
    hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)) : (char ?? ""),
  );

/** Whether a ```mermaid source may be handed to mermaid (see above); if not, it shows as code. */
export function mermaidDrawable(source: string): boolean {
  if (source.length > MAX_TEXT) return false;
  const text = source.replace(/\r\n?/g, "\n");
  const front = text.match(FRONT_MATTER)?.[2];
  if (front?.split("\n").some((line) => line.trim() && !TITLE_LINE.test(line))) return false;
  if (text.includes("%%{")) return false;
  if (text.includes("@{") && /img|\\/i.test(text)) return false;
  if (text.includes("sequenceDiagram") && ACTOR_MENU.test(text)) return false;
  return !TAG_WITH_ATTRIBUTE.test(text) && !CSS_LOAD.test(cssUnescaped(text));
}

/**
 * A diagram drawn: its image (data URL), its own width in CSS pixels (null when its SVG doesn't say) and, when the
 * diagram has them, its accTitle and accDescr.
 */
export type Drawing = { src: string; width: number | null; title?: string; description?: string };

/** Mermaid's SVG as an image at its own size, its accessible name and description taken out for the <img>. */
export function svgDrawing(svg: string): Drawing {
  // Its own size, not its box's width (mermaid's "100%"): a small diagram isn't blown up to fill the box.
  const size = svg.match(/viewBox="[^"]*?([\d.]+) ([\d.]+)"/);
  const own = size ? svg.replace('width="100%"', `width="${size[1]}" height="${size[2]}"`) : svg;
  // Mermaid writes accTitle and accDescr as the SVG's first <title> and <desc>, which an <img> hides from assistive
  // technology. DOMParser's document never loads anything.
  const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
  const childText = (tag: string) =>
    Array.from(root?.children ?? [])
      .find((el) => el.localName === tag)
      ?.textContent?.trim() || undefined;
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(own)}`,
    width: size ? Number(size[1]) : null,
    title: childText("title"),
    description: childText("desc"),
  };
}
