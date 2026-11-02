/**
 * The main window's cover (cover.rs): the boot sky with the agent, over the server's page while it
 * loads, so the window is never blank. Rust shows it and hides it (the page says when it painted); this page
 * only tells, while it shows, whether the server open now can be reached ("No internet connection…" or
 * "Can't reach {{host}}…"), and when it is back it asks to load the page again. Over the server here it says
 * that one's state instead (starting, updating, stopped, not starting, or Tailscale not connected), with the
 * buttons that fix it: a start or an update shows its time from 10 s, and Copy details once it takes longer than
 * expected. A server out of reach offers another one.
 */

import { isTailnet, serverHost } from "@agenteschat/client/lib/server";
import { drawAgent, idlePose } from "@agenteschat/ui/agent/engine";
import { startSky } from "@agenteschat/ui/sky/engine";
import { SKY_TONES } from "@agenteschat/ui/sky/math";
import { invoke } from "@tauri-apps/api/core";
import "@fontsource-variable/onest/index.css";
import "../fonts.css";
import "./cover.css";
import {
  coverHere,
  coverTailnet,
  isHereServer,
  type LocalServerStatus,
  STEP_SLOW_MS,
  stepClock,
  type Tailnet,
  UPDATE_SLOW_MS,
} from "../control/local-server";
import { platformOf } from "../control/platform";
import { SITE_URL } from "../control/version";
import { desktopStrings, systemLocale } from "../i18n";
import { elapsedClock, fillIn } from "../ui/time";

/** How long the cover waits before it asks whether the site can be reached, and how often after. */
const CHECK_MS = 3000;
/** Reachable but never said it painted (an older site): the cover steps aside after this. */
const GIVE_UP_MS = 15_000;

const strings = desktopStrings(systemLocale());
const words = strings.cover;
const platform = platformOf(navigator.userAgent);
const device = strings.device[platform];
const root = document.querySelector<HTMLElement>(".cover");
const line = document.querySelector<HTMLElement>(".cover__line");
const time = document.querySelector<HTMLElement>(".cover__time");
const sky = document.querySelector<HTMLCanvasElement>(".cover__sky");
const agent = document.querySelector<HTMLCanvasElement>(".cover__agent");
const acts = document.querySelector<HTMLElement>(".cover__acts");
document.documentElement.lang = systemLocale();

let shownAt = performance.now();
/** The site couldn't be reached: the sky calms down and the agent closes its eyes. */
let unreachable = false;
/** The server here wasn't up: once it answers, the page loads again. */
let hereWaiting = false;
/** Since when the cover sees the server here starting or updating. */
let waitSince: { state: "starting" | "migrating"; at: number } | null = null;

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

/** The cover's buttons: label and what it does; the first is the main one. */
function buttons(list: [string, () => void][]) {
  if (!acts) return;
  const now = list.map(([label]) => label).join("|");
  if (acts.dataset.now === now) return;
  acts.dataset.now = now;
  acts.replaceChildren(
    ...list.map(([label, run]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", run);
      return button;
    }),
  );
}

/**
 * The wait's time from 10 s, and once it takes longer than expected (30 s starting, 2 minutes updating), that line
 * with Copy details.
 */
function tick() {
  if (!waitSince) {
    if (time) time.textContent = "";
    return;
  }
  const ms = performance.now() - waitSince.at;
  const clock = stepClock(ms, waitSince.state === "migrating" ? UPDATE_SLOW_MS : STEP_SLOW_MS);
  if (time)
    time.textContent = clock.slow ? `${strings.here.slow} · ${elapsedClock(ms)}` : clock.time ? elapsedClock(ms) : "";
  buttons(clock.slow ? [[words.copy, copyDiagnostics]] : []);
}

/** Shown again (cover.rs `show`): the sky fills again, nothing is said yet. */
function shown() {
  shownAt = performance.now();
  unreachable = false;
  waitSince = null;
  say("");
  tick();
  buttons([]);
  root?.removeAttribute("data-fading");
  void check();
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

const localStatus = () => invoke<LocalServerStatus>("local_server_status").catch(() => null);

const copyDiagnostics = () =>
  void invoke<string>("local_server_diagnostics")
    .then((text) => navigator.clipboard.writeText(text))
    .then(() => say(words.copied))
    .catch(() => {});

/** The server here's state on the cover, with what fixes it. */
function showHere(state: NonNullable<ReturnType<typeof coverHere>>, tailnet: Tailnet | null) {
  const start = () => void invoke("local_server_start").catch(() => {});
  const fill = (text: string) => fillIn(text, { device });
  if (state === "starting" || state === "migrating") {
    if (waitSince?.state !== state) waitSince = { state, at: performance.now() };
    say(fill(state === "starting" ? words.starting : words.migrating));
    tick();
    return;
  }
  waitSince = null;
  tick();
  if (state === "stopped") {
    say(fill(words.stopped));
    buttons([[words.start, start]]);
  } else if (state === "failing") {
    say(fill(words.failing));
    buttons([
      [words.retry, start],
      [words.copy, copyDiagnostics],
    ]);
  } else {
    const onlyHere: [string, () => void] = [
      fill(words.onlyHere),
      () => void invoke("local_server_reach", { on: false }).catch(() => {}),
    ];
    const next = coverTailnet(platform, tailnet);
    if (next === "openTailscale") {
      say(fill(words.tailnetOff));
      buttons([[words.openTailscale, () => void invoke("tailscale_open", { page: "app" }).catch(() => {})], onlyHere]);
    } else {
      say(`${fill(words.tailnetOff)} ${words[next]}`);
      buttons([onlyHere]);
    }
  }
}

async function check() {
  if (document.visibilityState !== "visible" || root?.hasAttribute("data-fading")) return;
  const waited = performance.now() - shownAt;
  const server = await currentServer();
  const here = await localStatus();
  if (here && isHereServer(here, server)) {
    const answered = here.phase === "running" && (await reachable(server));
    const state = coverHere(here, server, answered);
    if (state) {
      hereWaiting = true;
      unreachable = state === "stopped" || state === "failing" || state === "tailnetOff";
      const tailnet = state === "tailnetOff" ? await invoke<Tailnet>("tailscale_status").catch(() => null) : null;
      showHere(state, tailnet);
      return;
    }
    if (hereWaiting) {
      // Up now: the page loads again; the cover stays until it painted.
      hereWaiting = false;
      shown();
      void invoke("cover_retry").catch(() => {});
      return;
    }
  }
  if (waited < CHECK_MS) return;
  if (!(await reachable(server))) {
    unreachable = true;
    say(unreachableText(server));
    buttons([[words.otherServer, () => void invoke("show_window", { name: "welcome" }).catch(() => {})]]);
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
setInterval(tick, 1000);
