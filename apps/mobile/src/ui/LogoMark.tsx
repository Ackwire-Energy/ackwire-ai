import { MONOGRAM_PATH, MONOGRAM_VIEWBOX } from "@agenteschat/ui/brand/ackwire";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "./theme";

/**
 * The Ackwire "A" monogram, as the web's (`packages/ui` `LogoMark`), in the theme's accent (`agent`). A workspace
 * without a logo of its own wears it.
 */
export function LogoMark({ size }: { size: number }) {
  const { colors } = useTheme();
  return (
    <Svg width={size} height={size} viewBox={MONOGRAM_VIEWBOX} accessibilityElementsHidden importantForAccessibility="no">
      <Path d={MONOGRAM_PATH} fill={colors.agent} />
    </Svg>
  );
}
