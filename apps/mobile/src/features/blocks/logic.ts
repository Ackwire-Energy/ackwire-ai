/*
 * Live blocks on the phone (ADR 0113). Pure, so it is unit-tested. The web view itself is the sandbox here, as for any
 * native host of pages like these: nothing of the app is in it to reach, and these are the rules that keep it so.
 */

/** Frames kept running at once: each is a browser of its own in memory, and the rest wait for a tap. */
export const MAX_LIVE_BLOCKS = 3;

/** Taller than this and a block is opened on its own screen, which shows it all. */
export const INLINE_MAX_HEIGHT = 560;

/**
 * Where a block may go: nowhere. Its page is the first load. Anything else would be how a page sends out what it
 * holds, so it is refused here and never handed to the system to open.
 */
export function blockMayLoad(url: string) {
  return url === "about:blank" || url === "about:srcdoc";
}

/** What a theme change says to the page already running. */
export const themeScript = (theme: "light" | "dark") =>
  `window.__agentesHost&&window.__agentesHost(${JSON.stringify({ theme })});true;`;

/**
 * The frames allowed to run, newest in. Whoever asks last gets a place, and the oldest one past the limit gives it
 * up: a long conversation never holds more than `MAX_LIVE_BLOCKS` browsers.
 */
export function withLiveBlock(live: readonly string[], key: string, max = MAX_LIVE_BLOCKS): string[] {
  return [...live.filter((k) => k !== key), key].slice(-max);
}
