import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * A box with a `max-height` holds more than it shows, at this width: measured when it lays out and again whenever its
 * content changes size (fonts, pictures, the page's width). While `active` is off (the box shows whole) it keeps its
 * last answer. With `over`, the answer is whether its content is taller than that instead: for a box whose
 * `max-height` depends on the answer, which would otherwise stay cut after its content shrank back under the limit.
 */
export function useOverflows(box: RefObject<HTMLElement | null>, active = true, over?: number): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !active) return;
    const measure = () => setCut(el.scrollHeight > (over ?? el.clientHeight) + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(measure);
    // The box itself while it still grows towards its `max-height`, its first child for what it holds past it.
    resized.observe(el);
    if (el.firstElementChild) resized.observe(el.firstElementChild);
    return () => resized.disconnect();
  }, [box, active, over]);
  return cut;
}
