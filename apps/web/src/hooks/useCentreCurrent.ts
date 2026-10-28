import { prefersReducedMotion } from "@agenteschat/ui";
import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * A strip that scrolls sideways (the settings' sections on a phone) brings its current item (`[aria-current]`) to
 * its middle, or as near as its ends allow: at once as it opens, gliding when another item becomes current. Only
 * the strip scrolls, never the page.
 */
export function useCentreCurrent(strip: RefObject<HTMLElement | null>, current: string) {
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again each time another item is current
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const place = (behavior: ScrollBehavior) => {
      const item = el.querySelector("[aria-current]");
      if (!item) return;
      const box = el.getBoundingClientRect();
      const at = item.getBoundingClientRect();
      el.scrollTo({ left: el.scrollLeft + at.left + at.width / 2 - (box.left + box.width / 2), behavior });
    };
    place(opened.current && !prefersReducedMotion() ? "smooth" : "instant");
    opened.current = true;
    // A first visit can lay the strip out before the web font arrives, and the font changes every item's width.
    const fonts = document.fonts;
    const again = () => place("instant");
    fonts?.addEventListener("loadingdone", again);
    return () => fonts?.removeEventListener("loadingdone", again);
  }, [strip, current]);
}
