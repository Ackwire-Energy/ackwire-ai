import { type NativeStackNavigationOptions, Stack, useIsFocused } from "expo-router";
import { type ReactElement, type ReactNode, useMemo } from "react";
import { type RefreshControlProps, ScrollView, StyleSheet, View } from "react-native";
import { LivePause } from "@/agent/live";
import { HeaderSlot, useHeaderSlot } from "./navigation";
import { Text } from "./Text";
import { useTheme } from "./theme";

export interface LargeTitleScreenProps {
  title: string;
  /** A line under the large title (the native bar has no subtitle; it scrolls with the content). */
  subtitle?: string;
  headerRight?: ReactNode;
  headerLeft?: ReactNode;
  children?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  /** Room under the content (default 24; the system already keeps content clear of the tab bar). */
  bottomInset?: number;
}

/**
 * A tab's root screen with the native large title (it collapses into the bar as the content scrolls),
 * inside the tab's stack (`useLargeTitleOptions`). This only sets the screen's header options and lays
 * out the scroll view: `contentInsetAdjustmentBehavior="automatic"` lets iOS place the content under the
 * large title and above the tab bar. Agents inside stop moving while the screen is not showing.
 */
export function LargeTitleScreen({
  title,
  subtitle,
  headerRight,
  headerLeft,
  children,
  refreshControl,
  bottomInset = 24,
}: LargeTitleScreenProps) {
  const { colors } = useTheme();
  const focused = useIsFocused();
  const right = useHeaderSlot(headerRight);
  const left = useHeaderSlot(headerLeft);
  const hasRight = Boolean(headerRight);
  const hasLeft = Boolean(headerLeft);
  // Stable options: `setOptions` runs when the title or the presence of an action changes, not per render.
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      title,
      ...(hasRight ? { headerRight: () => <HeaderSlot slot={right} /> } : {}),
      ...(hasLeft ? { headerLeft: () => <HeaderSlot slot={left} /> } : {}),
    }),
    [title, hasRight, hasLeft, right, left],
  );
  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={options} />
      <LivePause paused={!focused}>
        <ScrollView
          refreshControl={refreshControl}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: bottomInset }}
        >
          {subtitle ? (
            <Text variant="small" tone="muted" style={styles.subtitle}>
              {subtitle}
            </Text>
          ) : null}
          {children}
        </ScrollView>
      </LivePause>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  subtitle: { paddingHorizontal: 20, paddingBottom: 12 },
});
