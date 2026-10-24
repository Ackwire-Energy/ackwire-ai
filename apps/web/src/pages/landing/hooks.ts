import { cx } from "@agenteschat/ui";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanding } from "./context";

/** `prefers-reduced-motion: reduce` (false where `matchMedia` is missing). */
export function readReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  } catch {
    return false;
  }
}

export interface Run {
  /** False once a newer run started or the component unmounted. */
  alive(): boolean;
  /** Waits (at most 60 ms with reduced motion). */
  sleep(ms: number): Promise<void>;
}

/**
 * Cancellable async scripts (typing, work steps, the demo scenarios): `start`
 * cancels the previous one; `join` continues the current one.
 */
export function useRunner() {
  const { reduced } = useLanding();
  const gen = useRef(0);
  useEffect(() => {
    const g = gen;
    return () => {
      g.current++;
    };
  }, []);
  return useMemo(() => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, reduced ? Math.min(ms, 60) : ms));
    const bind = (id: number): Run => ({ alive: () => gen.current === id, sleep });
    return {
      start(fn: (run: Run) => Promise<void> | void) {
        gen.current++;
        void fn(bind(gen.current));
      },
      join: () => bind(gen.current),
      stop() {
        gen.current++;
      },
      sleep,
    };
  }, [reduced]);
}

/**
 * The agent's joy: happy eyes for a while and a hop. Each call restarts the hop
 * (two identical animations, alternated, so the browser replays it).
 */
export function useJoy() {
  const [joy, setJoy] = useState({ on: false, n: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const trigger = useCallback((ms = 1400) => {
    setJoy((j) => ({ on: true, n: j.n + 1 }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setJoy((j) => ({ ...j, on: false })), ms);
  }, []);
  const className = cx(joy.on && "lp-joy", joy.n > 0 && (joy.n % 2 ? "lp-hop-a" : "lp-hop-b"));
  return { className, trigger, on: joy.on };
}

const hasIO = () => typeof IntersectionObserver !== "undefined";

/** Calls `onChange` whenever the element enters or leaves the viewport (nothing without IntersectionObserver). */
export function useIntersection(
  ref: RefObject<Element | null>,
  onChange: (visible: boolean, observer: IntersectionObserver) => void,
  options: IntersectionObserverInit = {},
) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const { threshold, rootMargin } = options;
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasIO()) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) cb.current(e.isIntersecting, observer);
      },
      { threshold, rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, threshold, rootMargin]);
}

/** Whether the element is on screen (false without IntersectionObserver). */
export function useVisible(ref: RefObject<Element | null>, options: IntersectionObserverInit = {}) {
  const [visible, setVisible] = useState(false);
  useIntersection(ref, setVisible, options);
  return visible;
}

/** A ref callback that makes an avatar's eyes follow the pointer. */
export function useAimRef() {
  const { aim } = useLanding();
  return useCallback((el: HTMLElement | null) => (el ? aim.register(el) : undefined), [aim]);
}
