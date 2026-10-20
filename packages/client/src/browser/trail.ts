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
