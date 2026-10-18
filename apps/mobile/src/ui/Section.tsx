import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Count } from "./Count";
import { Text } from "./Text";

export interface SectionProps {
  title: string;
  count?: number;
  action?: { label: string; onPress: () => void };
  children?: ReactNode;
}

/** A titled block of the screen (header in faint, the count in Doto, an optional action on the right). */
export function Section({ title, count, action, children }: SectionProps) {
  return (
    <View style={{ paddingHorizontal: 16, marginTop: 22 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingBottom: 10 }}>
        <Text variant="label" accessibilityRole="header" style={{ flexShrink: 1 }}>
          {title}
        </Text>
        {count !== undefined ? <Count value={count} size={14} /> : null}
        <View style={{ flex: 1 }} />
        {action ? (
          <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={8}>
            <Text variant="label" tone="muted">
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}
