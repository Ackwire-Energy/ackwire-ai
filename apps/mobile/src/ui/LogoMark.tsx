import type { SkyPair } from "@agenteschat/ui/agent/engine";
import { PIXEL_MARK_VIEWBOX, pixelMarkRuns } from "@agenteschat/ui/brand/ackwire";
import Svg, { G, Rect } from "react-native-svg";
import { useTheme } from "./theme";

/** The pixel "A" never changes: its runs are computed once. */
const RUNS = pixelMarkRuns();

/**
 * The Ackwire "A" in the app's pixel style, as the web's (`packages/ui` `LogoMark`): the monogram's three arched
 * bands in the theme's Ackwire green, or the workspace's chosen accent. `sky` supplies another workspace's pair.
 * A workspace without a logo of its own wears it.
 */
export function LogoMark({ size, sky }: { size: number; sky?: SkyPair }) {
  const { colors } = useTheme();
  const tone = sky?.[1] ?? colors.agent;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={PIXEL_MARK_VIEWBOX}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <G shapeRendering="crispEdges">
        {RUNS.map((r) => (
          <Rect key={`${r.x}:${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={tone} />
        ))}
      </G>
    </Svg>
  );
}
