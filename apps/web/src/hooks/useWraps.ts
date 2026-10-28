import { type RefObject, useLayoutEffect, useState } from "react";

/** Whether an element's text runs past its first line, kept current as it reflows (a resize, other words). */
export function useWraps(ref: RefObject<HTMLElement | null>) {
  const [wraps, setWraps] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const line = Number.parseFloat(getComputedStyle(el).lineHeight);
      if (line > 0) setWraps(el.clientHeight > line * 1.5);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return wraps;
}
