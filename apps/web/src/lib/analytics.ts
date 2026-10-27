import { isEuropeanTimeZone } from "@agenteschat/ui";

/**
 * Himetrica, the product analytics (browser only). For now only the landing
 * page loads it (`loadAnalytics`), and only on agentes.chat itself: never in
 * dev or on a self-hosted server. Nor in Europe: its visitor id, stored on
 * the device, would need consent there. Calls made before the tracker loads
 * wait for it; without it (dev, tests, blocked, self-hosted, Europe) they do
 * nothing.
 */
const SRC = "https://cdn.himetrica.com/tracker.js";
/** Public by design: it identifies the site to the tracker in the browser. */
const KEY = "hm_0c03fab9fb8746a9c96bee5fddd4e338207019abbc283fb5";
/** The site that key belongs to. */
const SITE_HOST = "agentes.chat";

interface Himetrica {
  track(event: string, properties?: Record<string, unknown>): void;
}

declare global {
  interface Window {
    himetrica?: Himetrica;
  }
}

const waiting: ((h: Himetrica) => void)[] = [];

export function loadAnalytics() {
  if (location.hostname !== SITE_HOST || document.getElementById("himetrica")) return;
  // ponytail: the device's time zone setting, not where the device is. A consent bar would also cover travellers.
  if (isEuropeanTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)) return;
  const script = document.createElement("script");
  script.id = "himetrica";
  script.defer = true;
  script.src = SRC;
  script.setAttribute("data-api-key", KEY);
  script.addEventListener("load", () => {
    const h = window.himetrica;
    for (const run of waiting.splice(0)) if (h) run(h);
  });
  document.head.appendChild(script);
}

export function track(event: string, properties?: Record<string, unknown>) {
  const run = (h: Himetrica) => {
    try {
      h.track(event, properties);
    } catch {
      // Analytics never breaks the page.
    }
  };
  if (window.himetrica) run(window.himetrica);
  else if (document.getElementById("himetrica")) waiting.push(run);
}
