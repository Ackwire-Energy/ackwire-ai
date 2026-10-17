import type { ReactNode } from "react";
import { Pressable, Text as RNText, View } from "react-native";
import { Count } from "./Count";
import { useTheme } from "./theme";

export interface SectionProps {
  title: string;
  count?: number;
  action?: { label: string; onPress: () => void };
  children?: ReactNode;
}

/** A titled block of the screen (header in faint, the count in Doto, an optional action on the right). */
export function Section({ title, count, action, children }: SectionProps) {
  const { colors, fonts } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, marginTop: 22 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingBottom: 10 }}>
        <RNText accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.faint }}>
          {title}
        </RNText>
        {count !== undefined ? <Count value={count} size={14} /> : null}
        <View style={{ flex: 1 }} />
        {action ? (
          <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={8}>
            <RNText style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.muted }}>{action.label}</RNText>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}
