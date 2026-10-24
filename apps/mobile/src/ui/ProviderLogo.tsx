import { markOf, PROVIDER_MARKS } from "@agenteschat/ui/brand/marks";
import { Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "./theme";

/** Box and drawing per size, in points: the web's sizes. */
const SIZES = { xs: [14, 14], sm: [30, 16], tile: [48, 26] } as const;
const INITIAL_SIZE = { xs: 9, sm: 13, tile: 18 } as const;

export interface ProviderLogoProps {
  /** A provider, plan, brain or mission executor id (`anthropic`, `zai`, `claude_code`…). */
  id: string;
  /** `xs`: the bare mark beside text; `sm`: a 30 pt tile; `tile`: 48 pt, for list rows. */
  size?: "xs" | "sm" | "tile";
  /** Can't be used now (not installed, signed out, computer offline): gray and dim. */
  off?: boolean;
  /** Accessible name. Without it the logo is hidden from screen readers: the text next to it names the provider. */
  label?: string;
}

/**
 * The web's `ProviderLogo` on the phone: a maker's official mark (`brand/marks.ts`) in its brand color on a
 * neutral tile, one-color marks in ink; an id without a mark shows its initial.
 */
export function ProviderLogo({ id, size = "tile", off = false, label }: ProviderLogoProps) {
  const { colors } = useTheme();
  const key = markOf(id);
  const mark = key ? PROVIDER_MARKS[key] : null;
  const [box, drawing] = SIZES[size];
  const tile = size !== "xs" || !mark;
  // Beside text a one-color mark takes the small text's color, as on the web.
  const ink = size === "xs" ? colors.muted : colors.ink2;
  const fill = off ? colors.faint : (mark?.color ?? ink);
  return (
    <View
      {...(label
        ? { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label }
        : { accessible: false, importantForAccessibility: "no-hide-descendants" as const })}
      style={[
        { width: box, height: box, alignItems: "center", justifyContent: "center", opacity: off ? 0.5 : 1 },
        tile ? { borderRadius: Math.round(box / 3), backgroundColor: colors.sunken } : null,
      ]}
    >
      {mark ? (
        <Svg width={drawing} height={drawing} viewBox="0 0 24 24">
          <Path d={mark.path} fill={fill} />
        </Svg>
      ) : (
        // A fixed box: the letter doesn't grow with the text size setting.
        <Text allowFontScaling={false} style={{ fontSize: INITIAL_SIZE[size], fontWeight: "600", color: colors.muted }}>
          {id.trim().charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}
