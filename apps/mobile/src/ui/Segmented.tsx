import { Pressable, Text as RNText, View } from "react-native";
import { Count } from "./Count";
import type { FiltersProps } from "./Filters";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export type SegmentedProps = FiltersProps & {
  /**
   * As wide as its box, the segments sharing it evenly (a screen's views, as an agent's Hoje · Acesso · Memória).
   * `fit`: each as wide as its words first, so long labels stay on one line (a form's choice).
   */
  wide?: boolean | "fit";
};

/** The track's inset around the segments; a segment's corner is the track's less it, so the two stay concentric. */
const PAD = 4;
const RADIUS = 14;

/** A segmented control: a sunken track, the selected segment raised. */
export function Segmented({ items, value, onChange, wide = false }: SegmentedProps) {
  const { colors, shadows } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        padding: PAD,
        borderRadius: RADIUS,
        backgroundColor: colors.sunken,
        boxShadow: "inset 0px 1px 2px 0px rgba(0, 0, 0, 0.06)",
        alignSelf: wide ? "stretch" : "flex-start",
      }}
      accessibilityRole="tablist"
    >
      {items.map((item) => {
        const on = item.key === value;
        return (
          <Pressable
            key={item.key}
            onPress={() => {
              if (!on) haptics.selection();
              onChange(item.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={({ pressed }) => [
              wide === "fit" ? { flexGrow: 1 } : wide ? { flex: 1 } : null,
              pressed && !on ? { opacity: 0.6 } : null,
            ]}
            // A 28-point segment: the slop gives it the 44 a finger needs, past the track's own padding.
            hitSlop={{ top: 8, bottom: 8 }}
          >
            <View
              style={[
                {
                  // 28 inside the 4 pt inset: the control stays 36 tall.
                  minHeight: 28,
                  paddingHorizontal: 12,
                  borderRadius: RADIUS - PAD,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                },
                on ? { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` } : null,
              ]}
            >
              {item.icon ? <Icon name={item.icon} size={13} color={on ? colors.ink : colors.muted} /> : null}
              <RNText
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={[systemText("footnote", weights.semibold), { color: on ? colors.ink : colors.muted }]}
              >
                {item.label}
              </RNText>
              {item.count !== undefined ? (
                <Count value={item.count} size={13} color={on ? colors.ink : colors.muted} />
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
