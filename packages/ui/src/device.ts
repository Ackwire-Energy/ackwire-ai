/** A phone or tablet typing on its on-screen keyboard (touch first, no mouse). */
export const onScreenKeyboard = () =>
  typeof navigator !== "undefined" &&
  navigator.maxTouchPoints > 0 &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

/** A pointer that can rest over something without pressing it: a mouse or a pen, never a finger. */
export const hoverPointer = (pointerType: string) => pointerType === "mouse" || pointerType === "pen";

/**
 * Whether the one element an IntersectionObserver watches is on screen now (undefined: no answer). One call can
 * carry several answers for it, oldest first: hidden and shown again before the observer called (across a resize to
 * a phone's width and back) gives [off, on], and only the last one says where it is.
 */
export const onScreenNow = (entries: readonly { isIntersecting: boolean }[]) => entries.at(-1)?.isIntersecting;
