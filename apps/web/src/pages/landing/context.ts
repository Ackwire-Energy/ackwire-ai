import { createContext, useContext } from "react";

/** Avatars whose eyes follow the pointer (the giant, the maker preview, the crew). */
export interface AimRegistry {
  register(el: HTMLElement): () => void;
  /** Look at a point (client coordinates). */
  at(x: number, y: number): void;
  /** While locked, the pointer doesn't move the eyes (the hero input has focus). */
  lock(on: boolean): void;
}

export interface LandingContextValue {
  /** `prefers-reduced-motion: reduce`, read once. */
  reduced: boolean;
  aim: AimRegistry;
  /** Scrolls to a section of the page by id. */
  scrollTo(id: string): void;
  /** The current theme of the page (the maker's glow depends on it). */
  theme: "light" | "dark";
}

export const LandingContext = createContext<LandingContextValue | null>(null);

export function useLanding(): LandingContextValue {
  const value = useContext(LandingContext);
  if (!value) throw new Error("useLanding must be used inside the landing page");
  return value;
}
