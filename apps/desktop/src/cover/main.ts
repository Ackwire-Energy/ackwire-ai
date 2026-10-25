/**
 * The main window's cover (cover.rs): the boot sky with the agent, over the server's page while it
 * loads, so the window is never blank. Rust shows it and hides it (the page says when it painted); this page
 * only tells, while it shows, whether the server open now can be reached ("No internet connection…" or
 * "Can't reach {{host}}…"), and when it is back it asks to load the page again.
 */

import { isTailnet, serverHost } from "@agenteschat/client/lib/server";
import { drawAgent, idlePose } from "@agenteschat/ui/agent/engine";
import { startSky } from "@agenteschat/ui/sky/engine";
import { SKY_TONES } from "@agenteschat/ui/sky/math";
import { invoke } from "@tauri-apps/api/core";
import "../fonts.css";
import "./cover.css";
import { platformOf } from "../control/platform";
import { SITE_URL } from "../control/version";
import { DESKTOP_STRINGS, systemLocale } from "../i18n";
import type { DesktopTranslations } from "../i18n/keys.pt-BR";
import { fillIn } from "../ui/time";

/** How long the cover waits before it asks whether the site can be reached, and how often after. */
const CHECK_MS = 3000;
/** Reachable but never said it painted (an older site): the cover steps aside after this. */
const GIVE_UP_MS = 15_000;

const strings = DESKTOP_STRINGS[systemLocale()] as DesktopTranslations;
const words = strings.cover;
const device = strings.device[platformOf(navigator.userAgent)];
const root = document.querySelector<HTMLElement>(".cover");
const line = document.querySelector<HTMLElement>(".cover__line");
const sky = document.querySelector<HTMLCanvasElement>(".cover__sky");
const agent = document.querySelector<HTMLCanvasElement>(".cover__agent");
document.documentElement.lang = systemLocale();

let shownAt = performance.now();
/** The site couldn't be reached: the sky calms down and the agent closes its eyes. */
let unreachable = false;

if (sky) {
  // The same sky as the site's BootSplash (apps/web Sky.tsx), so the hand-over doesn't show.
  startSky(sky, () => ({
    pixel: 4,
    palette: SKY_TONES,
    sprites: { area: 700, max: 40 },
    rise: 2.2,
    light: 0.12,
    base: (u, v, t) => {
      const fill = Math.min(1, (performance.now() - shownAt) / 1800) * (unreachable ? 0.55 : 1);
      return -0.3 + 1.15 * fill * (0.35 + 0.65 * v) + 0.05 * Math.sin(u * 6 + t);
    },
  }));
}

if (agent) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = 72;
  agent.width = agent.height = Math.round(size * dpr);
  const ctx = agent.getContext("2d");
  const seed = Math.random() * 9;
  // With reduced motion the agent is drawn still (the sky does the same, packages/ui sky engine).
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = (now: number) => {
    if (ctx) {
      const s = agent.width;
      const inner = s * 0.84;
      ctx.clearRect(0, 0, s, s);
      const pose = idlePose(now / 1000, seed, { every: 10 });
      drawAgent(ctx, (s - inner) / 2, s - inner + s * 0.04, inner, {
        color: "sky",
        eyes: "round",
        cells: 12,
        pose: unreachable ? { ...pose, blink: false, expression: "closed" } : pose,
      });
    }
    if (!still) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function say(text: string) {
  if (line) line.textContent = text;
}

/** Shown again (cover.rs `show`): the sky fills again, nothing is said yet. */
function shown() {
  shownAt = performance.now();
  unreachable = false;
  say("");
  root?.removeAttribute("data-fading");
}

/** On its way out (cover.rs `hide`): it fades, the site shows through. */
function fade() {
  root?.setAttribute("data-fading", "");
}

const w = window as { __coverShown?: () => void; __coverFade?: () => void };
w.__coverShown = shown;
w.__coverFade = fade;

/** The server the main window opens (servers.json, through Rust); agentes.chat before one is chosen. */
const currentServer = () =>
  invoke<string | null>("cover_server").then(
    (s) => s ?? SITE_URL,
    () => SITE_URL,
  );

/** Whether the server answers at all (any answer: the cover can't read it, only that it came). */
async function reachable(server: string): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    await fetch(`${server}/api/health`, { mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

/** Why the page isn't there: no internet, or this server; on Tailscale, the likely reason too. */
function unreachableText(server: string): string {
  if (!navigator.onLine) return words.offline;
  const text = fillIn(words.unreachable, { host: serverHost(server) });
  return isTailnet(server) ? `${text} ${fillIn(words.tailnet, { device })}` : text;
}

async function check() {
  if (document.visibilityState !== "visible" || root?.hasAttribute("data-fading")) return;
  const waited = performance.now() - shownAt;
  if (waited < CHECK_MS) return;
  const server = await currentServer();
  if (!(await reachable(server))) {
    unreachable = true;
    say(unreachableText(server));
    return;
  }
  if (unreachable) {
    // Back: the site loads again; the cover stays until it painted.
    shown();
    void invoke("cover_retry").catch(() => {});
    return;
  }
  if (waited > GIVE_UP_MS) void invoke("cover_hide").catch(() => {});
}

setInterval(() => void check(), CHECK_MS);
