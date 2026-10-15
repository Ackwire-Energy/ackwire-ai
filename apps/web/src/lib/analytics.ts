/**
 * Himetrica, the product analytics (browser only). For now only the landing
 * page loads it (`loadAnalytics`), never on localhost. Calls made before the
 * tracker loads wait for it; without it (dev, tests, blocked) they do nothing.
 */
const SRC = "https://cdn.himetrica.com/tracker.js";
/** Public by design: it identifies the site to the tracker in the browser. */
const KEY = "hm_0c03fab9fb8746a9c96bee5fddd4e338207019abbc283fb5";

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
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || document.getElementById("himetrica")) return;
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
