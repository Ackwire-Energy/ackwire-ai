/** A phone or tablet typing on its on-screen keyboard (touch first, no mouse). */
export const onScreenKeyboard = () =>
  typeof navigator !== "undefined" &&
  navigator.maxTouchPoints > 0 &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

/** A pointer that can rest over something without pressing it: a mouse or a pen, never a finger. */
export const hoverPointer = (pointerType: string) => pointerType === "mouse" || pointerType === "pen";

/** Keys that move the focus, besides Tab, where nothing is typed: in a field they move the caret. */
const MOVES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const PRESSED_INPUTS = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);
const typesIn = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !PRESSED_INPUTS.has(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable);

let byKeys = false;
let tracked: Document | null = null;

/**
 * Whether the person moves around with the keys: Tab, or an arrow or a page key where nothing is typed, until the
 * next press of a mouse, a finger or a pen. A key held with ⌘, Ctrl or Alt is a shortcut, not a move, except Tab: by
 * default, Safari and the macOS app reach a button only with ⌥Tab. Typing, Enter and Escape change nothing.
 * `<html data-pointer>` says the pointer leads, so that only the keys draw focus rings: a browser also draws one on
 * whatever a script focuses after any key, typing included (a dialog that closes on Enter gives the focus back to its
 * button). Installed once per document, by the first caller.
 */
export function trackInput() {
  if (typeof document === "undefined" || tracked === document) return;
  tracked = document;
  const root = document.documentElement;
  const set = (keys: boolean) => {
    byKeys = keys;
    root.toggleAttribute("data-pointer", !keys);
  };
  set(false);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab" || (MOVES.has(e.key) && !(e.metaKey || e.ctrlKey || e.altKey) && !typesIn(e.target)))
        set(true);
    },
    true,
  );
  document.addEventListener("pointerdown", () => set(false), true);
}

/** The person moves with the keys now (`trackInput`). */
export const movesByKeys = () => byKeys;

/**
 * Whether the one element an IntersectionObserver watches is on screen now (undefined: no answer). One call can
 * carry several answers for it, oldest first: hidden and shown again before the observer called (across a resize to
 * a phone's width and back) gives [off, on], and only the last one says where it is.
 */
export const onScreenNow = (entries: readonly { isIntersecting: boolean }[]) => entries.at(-1)?.isIntersecting;

/** The last control in `root` that Tab reaches, counted as Radix's focus scope does: tab index 0 or more, enabled, shown. */
export const lastTabbable = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>("*")]
    .filter(
      (el) =>
        el.tabIndex >= 0 &&
        !(el as HTMLButtonElement).disabled &&
        !el.hidden &&
        el.checkVisibility?.({ checkVisibilityCSS: true }) !== false,
    )
    .at(-1);
