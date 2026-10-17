import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { frameClock } from "./clock";

/**
 * Living things (agents, orbits) move only on screens that are showing. `LivePause` marks a subtree as
 * off screen (LargeTitleScreen wraps its content with the screen's focus); the shared clock itself is
 * paused while the app is in the background (AppProviders).
 */
const PausedContext = createContext(false);

export function LivePause({ paused, children }: { paused: boolean; children?: ReactNode }) {
  const parent = useContext(PausedContext);
  return <PausedContext.Provider value={parent || paused}>{children}</PausedContext.Provider>;
}

export const useLivePaused = () => useContext(PausedContext);

/**
 * The shared clock's time in seconds, updating ~25 times a second while `active` (and not paused);
 * otherwise `still`.
 */
export function useFrameTime(active: boolean, still: number): number {
  const paused = useLivePaused();
  const running = active && !paused;
  const [t, setT] = useState(() => (running ? frameClock.time() : still));
  useEffect(() => {
    if (!running) return;
    return frameClock.subscribe(setT);
  }, [running]);
  return running ? t : still;
}
