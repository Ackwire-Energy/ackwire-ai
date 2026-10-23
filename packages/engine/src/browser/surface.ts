import type { BrowserBatchCommand } from "@agenteschat/adapters";
import {
  type ActTarget,
  observeSnapshot,
  type ScreenAction,
  type ScreenActOutcome,
  type ScreenImage,
  type ScreenObservation,
  type ScreenSurface,
} from "../screen";

/**
 * The agent's browser as a screen (ADR 0054): how a plan's actions become
 * `agent-browser` commands, how the page settles after each one, and how it
 * is looked at. With a runner on protocol 17 an action, its settling and the
 * look after it go in one round trip (`browser.batch`); older runners get the
 * same commands one at a time.
 */

export type BrowserReply = { ok: true; data: unknown } | { ok: false; text: string };

/** How one tool call reaches the agent's browser (its machine, agent and sites already bound). */
export interface BrowserLink {
  act(command: BrowserBatchCommand): Promise<BrowserReply>;
  /** In order, stopping at the first failure that isn't tolerated (fewer replies than commands then). */
  batch(commands: BrowserBatchCommand[]): Promise<BrowserReply[]>;
  /** The page as an annotated JPEG, or null (an older runner, or an image a judge can't take). */
  capture(): Promise<ScreenImage | null>;
}

/** Default time for one command; page loads may take longer. */
export const COMMAND_SECONDS = 30;
export const OPEN_SECONDS = 60;

/**
 * Settling: resolves once the page's DOM has been quiet for 150 ms (at most
 * 2 s), so a look after a click sees what the click did, not the page halfway
 * through. A navigation cuts it short (its document goes away), which the
 * load wait after it covers.
 */
const SETTLE_JS =
  "new Promise((resolve) => { let quiet; let cap; const done = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(true); }; const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, 150); }); observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); quiet = setTimeout(done, 150); cap = setTimeout(done, 2000); })";
const SETTLE_B64 = Buffer.from(SETTLE_JS, "utf8").toString("base64");

const settle: BrowserBatchCommand = { command: "eval", args: ["-b", SETTLE_B64], timeoutSeconds: 5, tolerate: true };
const loaded: BrowserBatchCommand = {
  command: "wait",
  args: ["--load", "domcontentloaded", "--timeout", "8000"],
  timeoutSeconds: 10,
  tolerate: true,
};
/** The look after an action: the whole page, compact (text and the elements' refs). */
export const LOOK: BrowserBatchCommand = { command: "snapshot", args: ["-c"], timeoutSeconds: COMMAND_SECONDS };

const ref = (at: { ref: string }) => `@${at.ref.replace(/^@/, "")}`;
const isPoint = (at: ActTarget): at is { x: number; y: number } => "x" in at;
const px = (n: number) => String(Math.max(0, Math.round(n)));

/** A point on the page, clicked like a person: move there, press, release. */
const clickAt = (at: { x: number; y: number }): BrowserBatchCommand[] => [
  { command: "mouse", args: ["move", px(at.x), px(at.y)], timeoutSeconds: COMMAND_SECONDS },
  { command: "mouse", args: ["down", "left"], timeoutSeconds: COMMAND_SECONDS },
  { command: "mouse", args: ["up", "left"], timeoutSeconds: COMMAND_SECONDS },
];

/** Selects what the focused field holds, so typing replaces it (a fill on a point). */
const SELECT_FOCUSED = "document.activeElement && document.activeElement.select && document.activeElement.select()";

/** The commands for one action (`secretSite`: where a `type_secret`'s secret may be typed). */
export function actionCommands(
  action: ScreenAction,
  secretSite: (name: string) => string | null,
): BrowserBatchCommand[] {
  const c = (command: string, ...args: string[]): BrowserBatchCommand => ({
    command,
    args,
    timeoutSeconds: COMMAND_SECONDS,
  });
  switch (action.kind) {
    case "open":
      return [{ command: "open", args: [action.url], timeoutSeconds: OPEN_SECONDS }];
    case "back":
      return [c("back")];
    case "press":
      return [c("press", action.key)];
    case "scroll":
      return [c("scroll", action.direction, String(action.pixels))];
    case "pause":
      return [{ command: "wait", args: [String(action.ms)], timeoutSeconds: Math.ceil(action.ms / 1000) + 5 }];
    case "click":
      return isPoint(action.at) ? clickAt(action.at) : [c("click", ref(action.at))];
    case "hover":
      return isPoint(action.at) ? [c("mouse", "move", px(action.at.x), px(action.at.y))] : [c("hover", ref(action.at))];
    case "check":
    case "uncheck":
      // On a point a click toggles it; with a ref the browser sets it as asked.
      return isPoint(action.at) ? clickAt(action.at) : [c(action.kind, ref(action.at))];
    case "fill":
      return isPoint(action.at)
        ? [
            ...clickAt(action.at),
            { command: "eval", args: [SELECT_FOCUSED], timeoutSeconds: 5, tolerate: true },
            c("keyboard", "inserttext", action.text),
          ]
        : [c("fill", ref(action.at), action.text)];
    case "select":
      if (isPoint(action.at)) throw new Error("a list is picked by its element, not a point on the page");
      return [c("select", ref(action.at), action.value)];
    case "type_secret": {
      const site = secretSite(action.secret);
      if (!site) throw new Error(`no secret named ${action.secret} was delivered for a site`);
      return [c("agentes:type_secret", ref(action.at), action.secret, site)];
    }
  }
}

/** A snapshot's answer as a screen. */
export function observationOf(data: unknown): ScreenObservation | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.snapshot !== "string") return null;
  const url = typeof d.origin === "string" ? d.origin : typeof d.url === "string" ? d.url : null;
  return observeSnapshot({ text: d.snapshot, url, refs: d.refs });
}

export interface BrowserSurfaceOptions {
  link: BrowserLink;
  /** A `type_secret`'s site, from what `request_secret` delivered (never from the agent). */
  secretSite?: (name: string) => string | null;
  /** Every look, as it happens (the caller keeps the last one). */
  onLook?: (o: ScreenObservation) => void;
}

/** The browser as a `ScreenSurface`. */
export function browserSurface(options: BrowserSurfaceOptions): ScreenSurface {
  const { link } = options;
  const seen = (o: ScreenObservation | null) => {
    if (o) options.onLook?.(o);
    return o;
  };
  return {
    async observe() {
      const r = await link.act(LOOK);
      if (!r.ok) throw new Error(r.text);
      const o = seen(observationOf(r.data));
      if (!o) throw new Error("the browser didn't return the page");
      return o;
    },
    async perform(action, { settle: wait }): Promise<ScreenActOutcome> {
      let commands: BrowserBatchCommand[];
      try {
        commands = actionCommands(action, options.secretSite ?? (() => null));
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const all = wait ? [...commands, settle, loaded, settle, LOOK] : commands;
      const replies = await link.batch(all);
      // The action's own commands must all have gone through.
      for (let i = 0; i < commands.length; i++) {
        const r = replies[i];
        if (!r) return { ok: false, error: "the browser stopped before the action" };
        if (!r.ok && !(commands[i] as BrowserBatchCommand).tolerate) return { ok: false, error: r.text };
      }
      const last = wait ? replies[all.length - 1] : undefined;
      return { ok: true, observation: last?.ok ? seen(observationOf(last.data)) : null };
    },
    capture: () => link.capture(),
  };
}
