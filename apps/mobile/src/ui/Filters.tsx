import { useEffect, useRef } from "react";
import { Pressable, Text as RNText, ScrollView, View } from "react-native";
import { Count } from "./Count";
import { haptics } from "./haptics";
import type { IconName } from "./icons.data";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/** How much of the pill before stays in sight when the row follows the selected one. */
const PEEK = 40;

export interface FilterItem {
  key: string;
  label: string;
  count?: number;
  /** A small icon before the label (Segmented only). */
  icon?: IconName;
}

export interface FiltersProps {
  items: FilterItem[];
  value: string;
  onChange: (key: string) => void;
}

/** Horizontal pills over a list; the selected one is ink, and the row follows it when it changes from outside. */
export function Filters({ items, value, onChange }: FiltersProps) {
  const { colors } = useTheme();
  const row = useRef<ScrollView>(null);
  const lefts = useRef(new Map<string, number>());
  useEffect(() => {
    const left = lefts.current.get(value);
    if (left !== undefined) row.current?.scrollTo({ x: Math.max(0, left - PEEK), animated: true });
  }, [value]);
  return (
    <ScrollView
      ref={row}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingBottom: 4 }}
    >
      {items.map((item) => {
        const on = item.key === value;
        const color = on ? colors.bg : colors.muted;
        return (
          <Pressable
            key={item.key}
            onLayout={(e) => lefts.current.set(item.key, e.nativeEvent.layout.x)}
            onPress={() => {
              if (!on) haptics.selection();
              onChange(item.key);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
          >
            <View
              style={{
                minHeight: 34,
                paddingHorizontal: 14,
                borderRadius: 999,
                backgroundColor: on ? colors.ink : colors.sunken,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
              }}
            >
              <RNText
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={[systemText("subhead", weights.semibold), { color }]}
              >
                {item.label}
              </RNText>
              {item.count !== undefined ? <Count value={item.count} size={14} color={color} /> : null}
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
