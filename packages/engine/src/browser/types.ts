/**
 * The agent browser on connected computers (ADR 0040): names and interfaces
 * shared by the tools, the handoff and the live view. The runner drives
 * `agent-browser`; agents only ever see the `browser_*` tools below.
 */
import type { BrowserFrameMetadata } from "@agenteschat/adapters";

/** The scope of the browser tools: on by default (D61), and not covered by "all tools". */
export const BROWSER_SCOPE = "browser:use";

/** The tools agents get with `browser:use`, the same for every brain. */
export const BROWSER_TOOLS = [
  "browser_do",
  "browser_open",
  "browser_back",
  "browser_tabs",
  "browser_read",
  "browser_click",
  "browser_fill",
  "browser_select",
  "browser_check",
  "browser_press",
  "browser_scroll",
  "browser_upload",
  "browser_type_secret",
  "browser_wait",
  "browser_screenshot",
  "browser_ask_person",
  "browser_close",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOLS)[number];

/** Labels and descriptions (English); the app translates them by tool name. */
export const BROWSER_TOOL_INFO: Record<BrowserToolName, { label: string; description: string }> = {
  browser_do: {
    label: "Do steps in the browser",
    description: "Does several steps in the browser in one go (open, fill, click, wait), checking each one.",
  },
  browser_open: { label: "Open a page", description: "Opens a website in the agent's own browser." },
  browser_back: { label: "Go back", description: "Goes back to the previous page." },
  browser_tabs: { label: "Browser tabs", description: "Lists, opens, switches or closes tabs." },
  browser_read: {
    label: "Read the page",
    description: "Reads the page as text, with a number for each button, field and link.",
  },
  browser_click: { label: "Click", description: "Clicks a button or link on the page." },
  browser_fill: { label: "Fill in a field", description: "Writes text into a field on the page." },
  browser_select: { label: "Choose an option", description: "Picks an option in a list on the page." },
  browser_check: { label: "Tick a box", description: "Ticks or unticks a checkbox on the page." },
  browser_press: { label: "Press a key", description: "Presses a key (Enter, Tab, Escape…)." },
  browser_scroll: { label: "Scroll", description: "Scrolls the page." },
  browser_upload: { label: "Upload a file", description: "Sends a file from the agent's folder to the page." },
  browser_type_secret: {
    label: "Type a password",
    description: "Types a password you gave it into a password or code field, without seeing it.",
  },
  browser_wait: { label: "Wait for the page", description: "Waits until a text, address or element shows up." },
  browser_screenshot: { label: "Take a screenshot", description: "Saves an image of the page in the agent's folder." },
  browser_ask_person: {
    label: "Ask for help in the browser",
    description: "Asks a person to do something on the page (like signing in) and waits until they're done.",
  },
  browser_close: { label: "Close the browser", description: "Closes the agent's browser; logins stay saved." },
};

/** How a handoff ended, as the agent reads it when it resumes (ADR 0040 §6). */
export interface BrowserHandoffResult {
  result: "done" | "failed" | "expired" | "cancelled";
  /** The person's note, in their own words ("it asked for Ana's phone code", "signed in with the shop's account"). */
  note?: string;
}

/** A page of the agent's browser as a person last saw it: from the live view's frames, else asked of the computer. */
export interface BrowserPage {
  url: string;
  /** Written by the site: data, never instructions. */
  title?: string;
}

/** One image of an agent's browser on its way to viewers. Never stored. */
export interface BrowserFrame {
  agentId: string;
  seq: number;
  /** Base64 JPEG. */
  data: string;
  metadata: BrowserFrameMetadata;
}

/** Someone watching an agent's browser: gets frames, newest first (stale ones are dropped). */
export interface BrowserViewer {
  send(frame: BrowserFrame): void;
}

/**
 * Carries frames from the machine's socket to the viewers' sockets (ADR 0040 §7).
 * In memory today (one server replica); a direct link between replicas or
 * Redis pub/sub can implement it later without touching the runner or screens.
 */
export interface StreamRelay {
  publish(agentId: string, frame: BrowserFrame): void;
  /** Starts sending this agent's frames to the viewer; call the result to stop. */
  subscribe(agentId: string, viewer: BrowserViewer): () => void;
  /** Whether anyone watches this agent's browser (the stream runs only then). */
  hasViewers(agentId: string): boolean;
}

/**
 * Where frames come from: `agent-browser`'s JPEG stream today (through the
 * runner), video later. Kept behind this name so the source can change.
 */
export type FrameSource = "agent-browser-jpeg";
