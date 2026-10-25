import {
  dark as darkTokens,
  light as lightTokens,
  type ShadowLayer,
  type ShadowName,
  type ThemeColors,
  shadows as tokenShadows,
} from "@agenteschat/tokens";

/**
 * The phone app's colors (pure: no React Native import, so it is unit-tested). The design system's tokens,
 * with the light theme made native like iOS: white lists and
 * chat, the grouped gray only where iOS groups (profile, Atividade, sheets) with white cards on it, lighter
 * fills, darker secondary text and lighter hairlines. The dark theme stays the tokens'.
 */
export type Scheme = "light" | "dark";

export interface AppColors extends ThemeColors {
  /** The grouped background (Settings-like screens, Atividade, sheets); white cards sit on it. */
  grouped: string;
  /** My own message bubble. */
  bubble: string;
  /** The only color for "waits on you" (requests, questions, what expires). */
  amber: string;
  /** A small tag's fill (chips, states). */
  chip: string;
  /** Unread: the row's dot, the same red as the tab bar's badge (the system red). */
  badge: string;
}

/** Light, native: what changes from the tokens. */
const NATIVE_LIGHT: Partial<ThemeColors> = {
  bg: "#ffffff",
  raised: "#ffffff",
  raised2: "#ffffff",
  sunken: "#f2f2f5",
  glass: "rgba(255, 255, 255, 0.78)",
  glassSolid: "#f9f9f9",
  line: "rgba(60, 60, 67, 0.08)",
  line2: "rgba(60, 60, 67, 0.14)",
  ink: "#000000",
  ink2: "#1c1c1e",
  muted: "#48484d",
  faint: "#6c6c70",
  plate: "rgba(120, 120, 128, 0.1)",
  plateSoft: "rgba(120, 120, 128, 0.06)",
  surface: "#ffffff",
  surfaceRaised: "#ffffff",
  surfaceSunken: "#f2f2f5",
  inkMuted: "#48484d",
  action: "#000000",
  onAction: "#ffffff",
  success: "#000000",
};

export function appColors(scheme: Scheme): AppColors {
  if (scheme === "dark") {
    return {
      ...darkTokens,
      glass: "rgba(28, 28, 27, 0.86)",
      grouped: darkTokens.bg,
      bubble: darkTokens.raised,
      amber: "#e8ac4c",
      chip: darkTokens.sunken,
      badge: "#ff453a",
    };
  }
  const base = { ...lightTokens, ...NATIVE_LIGHT };
  return {
    ...base,
    grouped: "#f2f2f7",
    bubble: "#eef0f3",
    amber: "#b26a00",
    chip: "rgba(120, 120, 128, 0.1)",
    badge: "#ff3b30",
  };
}

/** Light elevations are softer (a hairline and a short shadow, like iOS); dark keeps the tokens'. */
const NATIVE_LIGHT_SHADOWS: Partial<Record<ShadowName, ShadowLayer[]>> = {
  e1: [
    { x: 0, y: 1, blur: 2, spread: 0, color: "rgba(0, 0, 0, 0.04)" },
    { x: 0, y: 0, blur: 0, spread: 0.5, color: "rgba(60, 60, 67, 0.12)" },
  ],
  e2: [
    { x: 0, y: 4, blur: 14, spread: -6, color: "rgba(0, 0, 0, 0.12)" },
    { x: 0, y: 0, blur: 0, spread: 0.5, color: "rgba(60, 60, 67, 0.14)" },
  ],
};

export function appShadows(scheme: Scheme): Record<ShadowName, ShadowLayer[]> {
  return scheme === "dark" ? tokenShadows.dark : { ...tokenShadows.light, ...NATIVE_LIGHT_SHADOWS };
}
