import { Pressable, Text as RNText, ScrollView, View } from "react-native";
import { Count } from "./Count";
import { haptics } from "./haptics";
import { useTheme } from "./theme";

export interface FilterItem {
  key: string;
  label: string;
  count?: number;
}

export interface FiltersProps {
  items: FilterItem[];
  value: string;
  onChange: (key: string) => void;
}

/** Horizontal pills over a list; the selected one is ink. */
export function Filters({ items, value, onChange }: FiltersProps) {
  const { colors, fonts } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingBottom: 4 }}
    >
      {items.map((item) => {
        const on = item.key === value;
        const color = on ? colors.bg : colors.muted;
        return (
          <Pressable
            key={item.key}
            onPress={() => {
              if (!on) haptics.selection();
              onChange(item.key);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
          >
            <View
              style={{
                height: 34,
                paddingHorizontal: 14,
                borderRadius: 999,
                backgroundColor: on ? colors.ink : colors.sunken,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
              }}
            >
              <RNText style={{ fontFamily: fonts.semibold, fontSize: 14, color }}>{item.label}</RNText>
              {item.count !== undefined ? <Count value={item.count} size={14} color={color} /> : null}
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
