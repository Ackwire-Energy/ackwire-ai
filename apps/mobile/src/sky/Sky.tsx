import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/ui/theme";
import { Dither } from "./Dither";
import { fromSurface } from "./math";

export interface SkyProps {
  color?: AgentColorName;
  /** How far the surface goes into the agent's color (default 0.9; the home uses 0.7). */
  depth?: number;
  /** Fade to the bottom from this height share (default 0.55, as on the web). */
  fade?: number;
  /**
   * The surface it blends into (prototype `data-surf`): the screen's background (default), a raised card,
   * or the grouped gray.
   */
  surface?: "bg" | "raised" | "grouped";
  style?: StyleProp<ViewStyle>;
}

/** The pixel sky (home greeting, agent cover, auth): a glow low in the middle and a few stars. */
export function Sky({ color = "sky", depth = 0.9, fade = 0.55, surface = "bg", style }: SkyProps) {
  const { colors } = useTheme();
  return <Dither kind="sky" tones={fromSurface(colors[surface], depth, color)} pixel={4} fade={fade} style={style} />;
}
