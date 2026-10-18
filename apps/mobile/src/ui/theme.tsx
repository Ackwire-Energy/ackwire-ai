import {
  dark as darkColors,
  light as lightColors,
  motion as motionCurves,
  radius as radii,
  type ShadowLayer,
  shadows as shadowLayers,
  type ThemeColors,
} from "@agenteschat/tokens";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, Platform, useColorScheme } from "react-native";
import { readValue, STORED, writeValue } from "@/lib/storage";

export { weights } from "./type-scale";

/**
 * The theme for React Native, from `@agenteschat/tokens` (tokens.css is the source of truth).
 * Rules (design system): neutral cards, chips with icons (never colored dots), the brand blue only for
 * agent identity, names in ink, the mono font only for code, Doto for every count.
 */
export type Scheme = "light" | "dark";
export type ThemePreference = "system" | Scheme;

/** A token shadow as React Native's `boxShadow` string (New Architecture: layers, spread and inset). */
export const boxShadow = (layers: readonly ShadowLayer[]) =>
  layers.map((l) => `${l.inset ? "inset " : ""}${l.x}px ${l.y}px ${l.blur}px ${l.spread}px ${l.color}`).join(", ");

/**
 * Brand font families as loaded by `useAppFonts` (static files: React Native has no variable axes).
 * Body and UI text use the system font (SF Pro / Roboto) through `Text` and `systemText`, with `weights`.
 */
export const fonts = {
  /** Funnel Display Light: large titles. */
  display: "FunnelDisplay-Light",
  /** Doto, ROND 100 instance (weight 600): every count. */
  dot: "Doto",
  /** Code only. */
  mono: Platform.select({ ios: "Menlo", default: "monospace" }),
} as const;

const bezier = (c: readonly number[]) => c as unknown as [number, number, number, number];

/** Motion: the token curves plus spring settings for Reanimated (the tokens' springy curve). */
export const motion = {
  spring: bezier(motionCurves.spring),
  out: bezier(motionCurves.out),
  ios: bezier(motionCurves.ios),
  /** `withSpring` config close to cubic-bezier(.34, 1.4, .5, 1): a small overshoot. */
  press: { damping: 15, stiffness: 420, mass: 0.6 },
  pop: { damping: 13, stiffness: 260, mass: 0.7 },
  sheet: { damping: 26, stiffness: 260, mass: 0.9 },
} as const;

export interface Theme {
  scheme: Scheme;
  colors: ThemeColors;
  shadows: { e1: string; e2: string; e3: string; top: string };
  radius: typeof radii;
  fonts: typeof fonts;
  motion: typeof motion;
  /** The person asked the phone for less motion: static agents, no orbit walk, no springs. */
  reducedMotion: boolean;
  preference: ThemePreference;
  setPreference(preference: ThemePreference): void;
}

export function makeTheme(scheme: Scheme, reducedMotion = false): Omit<Theme, "preference" | "setPreference"> {
  const s = shadowLayers[scheme];
  return {
    scheme,
    colors: scheme === "dark" ? darkColors : lightColors,
    shadows: { e1: boxShadow(s.e1), e2: boxShadow(s.e2), e3: boxShadow(s.e3), top: boxShadow(s.top) },
    radius: radii,
    fonts,
    motion,
    reducedMotion,
  };
}

const ThemeContext = createContext<Theme | null>(null);

/** System light/dark, or the person's choice (kept in SecureStore), and the reduced-motion setting. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setPref] = useState<ThemePreference>("system");
  const reducedMotion = useReducedMotionSetting();

  useEffect(() => {
    let alive = true;
    readValue(STORED.theme).then((v) => {
      if (alive && (v === "light" || v === "dark" || v === "system")) setPref(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPref(next);
    void writeValue(STORED.theme, next);
  }, []);

  const scheme: Scheme = preference === "system" ? (system === "dark" ? "dark" : "light") : preference;
  const value = useMemo<Theme>(
    () => ({ ...makeTheme(scheme, reducedMotion), preference, setPreference }),
    [scheme, reducedMotion, preference, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const fallback: Theme = { ...makeTheme("light"), preference: "system", setPreference: () => {} };

/** The current theme (light outside a provider). */
export function useTheme(): Theme {
  return useContext(ThemeContext) ?? fallback;
}

/** `AccessibilityInfo.isReduceMotionEnabled`, kept up to date. */
export function useReducedMotionSetting(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (alive) setReduced(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/** Whether to keep things still (reads the theme's setting). */
export const useReducedMotion = () => useTheme().reducedMotion;
