import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion, skiesHeld } from "../sky/engine";

/** How long the night takes to become day. */
export const DAWN_MS = 1700;

/**
 * 0 while `on` is false; once it turns true, 0 to 1 over `DAWN_MS` (at once with reduced motion or skies held still).
 * True from the start: 1, with no dawn to watch. `dusk`: turning false goes back to 0 the same way, not at once.
 */
export function useDawn(on: boolean, { dusk = false }: { dusk?: boolean } = {}) {
  const [day, setDay] = useState(on ? 1 : 0);
  const was = useRef(on);
  const now = useRef(day);
  now.current = day;
  useEffect(() => {
    const before = was.current;
    was.current = on;
    if (on === before) return;
    const to = on ? 1 : 0;
    if ((!on && !dusk) || prefersReducedMotion() || skiesHeld() || typeof requestAnimationFrame !== "function") {
      setDay(to);
      return;
    }
    const from = now.current;
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / DAWN_MS);
      setDay(from + (to - from) * k * k * (3 - 2 * k));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, dusk]);
  return day;
}
