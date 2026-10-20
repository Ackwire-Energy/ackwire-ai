/**
 * Where an agent browsed, after the run (`meta.browser` on its message): the browser calls the
 * server kept (tool, the site of an open, when), never anything of the page itself (ADR 0040 §7).
 */

/** One call in the agent's browser, as the message keeps it. */
export interface BrowserTrailStep {
  tool: string;
  /** The site of an open: host and path, no query string ("airbnb.com.br/rooms/48213"). */
  detail: string | null;
  at: string;
  failed: boolean;
}

/** The calls made on one page: from an open (or a new tab) to the next one. */
export interface BrowserTrailPage {
  /** The page's address without the scheme; null before the first open. */
  site: string | null;
  host: string | null;
  path: string;
  steps: BrowserTrailStep[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The steps on a message (`meta.browser.steps`), checked; empty when it didn't browse. */
export function browserTrailOf(meta: unknown): BrowserTrailStep[] {
  const steps = isObject(meta) && isObject(meta.browser) ? meta.browser.steps : null;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((s) =>
    isObject(s) && typeof s.tool === "string" && typeof s.at === "string" && !Number.isNaN(Date.parse(s.at))
      ? [
          {
            tool: s.tool,
            detail: typeof s.detail === "string" && s.detail ? s.detail : null,
            at: s.at,
            failed: s.failed === true,
          },
        ]
      : [],
  );
}

/** The opens that start a new page in the trail. */
const OPENS = new Set(["browser_open", "browser_tabs"]);

/** "airbnb.com.br/rooms/1" → ["airbnb.com.br", "/rooms/1"]. */
export function splitSite(site: string): [string, string] {
  const i = site.indexOf("/");
  return i < 0 ? [site, ""] : [site.slice(0, i), site.slice(i)];
}

/** The trail by page: an open with a site starts a page, the calls after it belong to it. */
export function browserTrailPages(steps: BrowserTrailStep[]): BrowserTrailPage[] {
  const pages: BrowserTrailPage[] = [];
  for (const s of steps) {
    const opens = OPENS.has(s.tool) && s.detail !== null;
    const last = pages.at(-1);
    if (!last || opens) {
      const [host, path] = opens && s.detail ? splitSite(s.detail) : [null, ""];
      pages.push({ site: opens ? s.detail : null, host, path, steps: [s] });
    } else last.steps.push(s);
  }
  return pages;
}

/** The sites it visited, in order of first visit ("airbnb.com.br", "google.com"). */
export function browserTrailHosts(steps: BrowserTrailStep[]): string[] {
  const hosts: string[] = [];
  for (const p of browserTrailPages(steps)) if (p.host && !hosts.includes(p.host)) hosts.push(p.host);
  return hosts;
}

/** From its first call to its last. */
export function browserTrailSpanMs(steps: BrowserTrailStep[]): number {
  const first = steps[0];
  const last = steps.at(-1);
  return first && last ? Math.max(0, Date.parse(last.at) - Date.parse(first.at)) : 0;
}

/** A page's address to open in the person's own browser; null for anything that isn't a plain host. */
export function browserTrailHref(site: string | null): string | null {
  if (!site || !/^[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(site)) return null;
  return `https://${site}`;
}

/**
 * What a step was, for its pixel column (telas/NavegadorResumo.html, B): an open is the whole
 * column, reading most of it, an action a stub, a print two cells; a failure the whole column in red.
 */
export type BrowserTrailKind = "open" | "read" | "act" | "shot" | "failed";

export function browserTrailKind(s: Pick<BrowserTrailStep, "tool" | "failed">): BrowserTrailKind {
  if (s.failed) return "failed";
  if (OPENS.has(s.tool)) return "open";
  if (s.tool === "browser_read") return "read";
  if (s.tool === "browser_screenshot") return "shot";
  return "act";
}

/** One line of the list: a step, or two that alternate ("Leu a página e clicou"), `times` in a row. */
export interface BrowserTrailLine {
  steps: BrowserTrailStep[];
  times: number;
}

const sameStep = (a: BrowserTrailStep | undefined, b: BrowserTrailStep | undefined) =>
  Boolean(a && b && a.tool === b.tool && a.failed === b.failed && a.detail === b.detail);

/** How many times `steps[i, i + n)` repeats from `i` on. */
function repeats(steps: BrowserTrailStep[], i: number, n: number) {
  let k = 1;
  while (steps.slice(i, i + n).every((s, j) => sameStep(s, steps[i + k * n + j]))) k++;
  return k;
}

/** A page's steps as lines, repeats folded: a pair that alternates first, then the same step in a row. */
export function browserTrailLines(steps: BrowserTrailStep[]): BrowserTrailLine[] {
  const lines: BrowserTrailLine[] = [];
  let i = 0;
  while (i < steps.length) {
    const pair = i + 1 < steps.length && !sameStep(steps[i], steps[i + 1]) ? repeats(steps, i, 2) : 1;
    const n = pair >= 2 ? 2 : 1;
    const times = n === 2 ? pair : repeats(steps, i, 1);
    lines.push({ steps: steps.slice(i, i + n), times });
    i += n * times;
  }
  return lines;
}
