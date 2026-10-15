import { useEffect, useRef, useState } from "react";
import { initialReveal, rebaseReveal, revealStep } from "@/lib/reveal";

const REDUCE = "(prefers-reduced-motion: reduce)";

const reducedNow = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCE).matches;

/** Whether the person asked for less motion (follows changes to the setting). */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCE);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/**
 * The part of a streaming `text` to show now: whole words, one step per
 * animation frame (`lib/reveal.ts`). With reduced motion, the whole text.
 */
export function useRevealedText(text: string) {
  const reduced = usePrefersReducedMotion();
  const instant = reduced || typeof requestAnimationFrame !== "function";
  const [shown, setShown] = useState(() => initialReveal(text));
  const shownRef = useRef(shown);
  const previous = useRef(text);

  useEffect(() => {
    shownRef.current = rebaseReveal(shownRef.current, previous.current, text);
    previous.current = text;
    if (instant) {
      shownRef.current = text.length;
      return;
    }
    if (shownRef.current >= text.length) {
      setShown(text.length);
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // Frames pause in a background tab: the first one back catches up at once.
      const next = revealStep(shownRef.current, text, now - last);
      last = now;
      shownRef.current = next;
      setShown(next);
      if (next < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, instant]);

  return instant ? text : text.slice(0, Math.min(shown, text.length));
}
