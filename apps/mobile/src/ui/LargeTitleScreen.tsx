import { type NativeStackNavigationOptions, Stack, useIsFocused } from "expo-router";
import { type ReactElement, type ReactNode, useMemo } from "react";
import { Platform, type RefreshControlProps, ScrollView, StyleSheet, View } from "react-native";
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
  /** The bar's leading item, a custom view (Android; on iOS it stops the large title collapsing). */
  left?: ReactNode;
  /** Native buttons on the bar's leading side (iOS). */
  leftActions?: HeaderAction[];
  /**
   * Revealed above the content when the list is pulled down (it sits above the first row, outside the
   * content, so only the bounce shows it; iOS only, where scroll views bounce). `pullDownHeight` is its
   * height.
   */
  pullDown?: ReactNode;
  pullDownHeight?: number;
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
 * the large title to follow its scroll. Nothing React goes inside the bar either (no custom header views, no
 * native search bar): on iOS 26 any of them keeps the large title expanded with the list scrolling under it.
 * Agents inside stop moving while the screen is not showing.
 */
export function LargeTitleScreen({
  title,
  subtitle,
  actions,
  left,
  leftActions,
  pullDown,
  pullDownHeight = 0,
  children,
  refreshControl,
  bottomInset = 24,
}: LargeTitleScreenProps) {
  const { colors } = useTheme();
  const focused = useIsFocused();
  const actionOptions = useHeaderActionOptions({ right: actions, left, leftActions });
  // Stable options: `setOptions` runs when the title or the actions change, not on every render.
  const options = useMemo<NativeStackNavigationOptions>(() => ({ title, ...actionOptions }), [title, actionOptions]);
  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={options} />
      <LivePause paused={!focused}>
        <ScrollView
          refreshControl={refreshControl}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: bottomInset }}
        >
          {pullDown && IOS ? (
            <View style={[styles.pullDown, { top: -pullDownHeight, height: pullDownHeight }]} pointerEvents="box-none">
              {pullDown}
            </View>
          ) : null}
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

const IOS = Platform.OS === "ios";

const styles = StyleSheet.create({
  screen: { flex: 1 },
  subtitle: { paddingHorizontal: 20, paddingBottom: 12 },
  pullDown: { position: "absolute", left: 0, right: 0, overflow: "hidden" },
});
