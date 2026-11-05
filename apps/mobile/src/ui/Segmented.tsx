import { Pressable, Text as RNText, View } from "react-native";
import { Count } from "./Count";
import type { FiltersProps } from "./Filters";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export type SegmentedProps = FiltersProps & {
  /** As wide as its box, the segments sharing it (a screen's views, as an agent's Hoje · Acesso · Memória). */
  wide?: boolean;
};

/** A segmented control: a sunken track, the selected segment raised. */
export function Segmented({ items, value, onChange, wide = false }: SegmentedProps) {
  const { colors, shadows } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        padding: 3,
        borderRadius: 12,
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
            style={wide ? { flex: 1 } : undefined}
          >
            <View
              style={[
                {
                  minHeight: 30,
                  paddingHorizontal: 12,
                  borderRadius: 9,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                },
                on ? { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` } : null,
              ]}
            >
              {item.icon ? <Icon name={item.icon} size={14} color={on ? colors.ink : colors.muted} /> : null}
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
