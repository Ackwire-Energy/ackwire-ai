import { type NativeStackNavigationOptions, Stack, useIsFocused } from "expo-router";
import { type ReactElement, type ReactNode, useMemo } from "react";
import { type RefreshControlProps, ScrollView, StyleSheet, View } from "react-native";
import { LivePause } from "@/agent/live";
import { type HeaderAction, useHeaderActionOptions } from "./headerActions";
import { Text } from "./Text";
import { useTheme } from "./theme";

export interface LargeTitleScreenProps {
  title: string;
  /** A line under the large title (the native bar has no subtitle; it scrolls with the content). */
  subtitle?: string;
  /** Buttons in the bar (native bar buttons on iOS). */
  actions?: HeaderAction[];
  children?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  /** Room under the content (default 24; the system already keeps content clear of the tab bar). */
  bottomInset?: number;
}

/**
 * A tab's root screen with the native large title (it collapses into the bar as the content scrolls),
 * inside the tab's stack (`useLargeTitleOptions`). This only sets the screen's header options and lays
 * out the scroll view: `contentInsetAdjustmentBehavior="automatic"` lets iOS place the content under the
 * large title and above the tab bar; it must stay the first view of the screen (nothing laid over it) for
 * the large title to follow its scroll. Agents inside stop moving while the screen is not showing.
 */
export function LargeTitleScreen({
  title,
  subtitle,
  actions,
  children,
  refreshControl,
  bottomInset = 24,
}: LargeTitleScreenProps) {
  const { colors } = useTheme();
  const focused = useIsFocused();
  const actionOptions = useHeaderActionOptions({ right: actions });
  // Stable options: `setOptions` runs when the title or the actions change, not on every render.
  const options = useMemo<NativeStackNavigationOptions>(() => ({ title, ...actionOptions }), [title, actionOptions]);
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
