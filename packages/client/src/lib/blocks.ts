import type { Poll } from "../api/types";
import { BLOCK_KIT_CSS, BLOCK_KIT_JS } from "./block-kit";
import { isolatedPage } from "./isolated-page";

/**
 * Live blocks in the apps (ADR 0113): the page a block runs as, and what the apps accept from it. A page is not to be
 * trusted, so everything here reads what it says as data: the text it proposes is shown as plain text beside a button
 * that lives outside it, and the person sends it. Pure, shared by the web and the phone.
 */

export interface BlockHost {
  theme: "light" | "dark";
  /** The agent's six tones, light to deep (`chartRamp`), for its charts. */
  ramp: string[];
  locale: string;
  labels: { send: string; more: string; thousand: string };
  /** What the person had set in this block, so a frame that comes back shows the same. */
  state?: Record<string, unknown>;
  /** `@font-face` CSS with the font inlined: a block has no network. */
  fontFace?: string;
  /** The app's font stack when it isn't our own (the phone's system font). */
  font?: string;
}

/** The whole document of a block: the policy first, then the kit, then what the agent wrote. */
export function blockPage(html: string, host: BlockHost): string {
  const { fontFace, font, ...boot } = host;
  const json = JSON.stringify(boot).replace(/</g, "\\u003c");
  const style = `${fontFace ?? ""}${BLOCK_KIT_CSS}${font ? `:root{--font:${font}}` : ""}`;
  return isolatedPage(html, `<style>${style}</style><script>window.__block=${json}</script><script>${BLOCK_KIT_JS}</script>`);
}

export type BlockEvent =
  | { type: "ready" }
  | { type: "height"; height: number }
  | { type: "state"; state: Record<string, unknown> }
  | { type: "draft"; text: string; label: string; ready: boolean; hint: string }
  | { type: "error"; message: string };

/** Bounds on what a page may put on our screen. */
const LABEL_CHARS = 40;
const TEXT_CHARS = 2000;
const HINT_CHARS = 200;
const MAX_HEIGHT = 20_000;

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** What a frame said, or null for anything that isn't one of ours. */
export function blockEvent(raw: unknown): BlockEvent | null {
  let m = raw;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== "object") return null;
  const e = m as Record<string, unknown>;
  if (e.agentes !== 1) return null;
  switch (e.type) {
    case "ready":
      return { type: "ready" };
    case "height":
      return typeof e.height === "number" && e.height >= 0
        ? { type: "height", height: Math.min(MAX_HEIGHT, Math.ceil(e.height)) }
        : null;
    case "state":
      return e.state && typeof e.state === "object"
        ? { type: "state", state: e.state as Record<string, unknown> }
        : null;
    case "draft": {
      const label = text(e.label, LABEL_CHARS);
      const said = text(e.text, TEXT_CHARS);
      if (!label) return null;
      return { type: "draft", text: said, label, ready: e.ready === true && said !== "", hint: text(e.hint, HINT_CHARS) };
    }
    case "error":
      return { type: "error", message: text(e.message, HINT_CHARS) };
    default:
      return null;
  }
}

/** How long a proposed text must stay put before its button counts: a page can't swap it under a click. */
export const DRAFT_SETTLE_MS = 400;

export interface PollOptionTally {
  option: number;
  label: string;
  voters: string[];
  /** Of everyone who can answer, 0 to 1. */
  share: number;
}

/** A poll's options with who marked each. */
export function pollTally(options: string[], poll: Poll): PollOptionTally[] {
  return options.map((label, option) => {
    const voters = poll.votes.filter((v) => v.option === option).map((v) => v.userId);
    return { option, label, voters, share: poll.people > 0 ? voters.length / poll.people : 0 };
  });
}

export const pollAnswered = (poll: Poll) => new Set(poll.votes.map((v) => v.userId)).size;
export const pollIsOpen = (poll: Poll, now = Date.now()) => !poll.closedAt && Date.parse(poll.closesAt) > now;

/** The viewer's marks after tapping an option. */
export function pollToggle(poll: Poll, userId: string, option: number, multiple: boolean): number[] {
  const mine = poll.votes.filter((v) => v.userId === userId).map((v) => v.option);
  if (mine.includes(option)) return mine.filter((o) => o !== option);
  return multiple ? [...mine, option] : [option];
}
