import { useHeaderHeight } from "expo-router/react-navigation";
import type { ReactElement, ReactNode } from "react";
import { Platform, type RefreshControlProps, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/ui";
import { FadingHeaderTitle, useCoverScroll, useScrollFade } from "@/ui/cover";
import { useColors } from "./hooks";
import { FocusLive, PushedHeader } from "./parts";

/**
 * A pushed screen with a large title (Issues, Drive): the title in Funnel Display is part of the content and
 * scrolls away; the bar's own title fades in as it goes, over a bar the content scrolls under (the system
 * glass on iOS 26). The same shape as the tabs' `LargeTitleScreen`, without the tab bar's room.
 */
export function PushedLargeTitle({
  title,
  right,
  refreshControl,
  onScrollBeginDrag,
  bottomInset = 24,
  children,
}: {
  title: string;
  right?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  onScrollBeginDrag?: () => void;
  /** Room under the content (a bottom bar over it needs more). */
  bottomInset?: number;
  children?: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  // iOS insets the scroll view by the bar (automatic adjustment): at rest the offset is minus its height.
  const { y, onScroll } = useCoverScroll(Platform.OS === "ios" ? headerHeight : 0);
  const titleFade = useScrollFade(y, 0, TITLE_GONE);
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={<FadingHeaderTitle y={y} from={BAR_TITLE_FROM} to={BAR_TITLE_TO} text={title} />}
        right={right}
        solid={false}
      />
      <FocusLive>
        <Animated.ScrollView
          onScroll={onScroll}
          onScrollBeginDrag={onScrollBeginDrag}
          scrollEventThrottle={16}
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={refreshControl}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + bottomInset }}
        >
          <Animated.View style={[styles.head, titleFade]}>
            <Text variant="display" accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
          </Animated.View>
          {children}
        </Animated.ScrollView>
      </FocusLive>
    </View>
  );
}

/** Scroll (from rest) by which the large title has faded out under the bar. */
const TITLE_GONE = 40;
/** The bar's title fades in over this stretch, as the large title leaves. */
const BAR_TITLE_FROM = 28;
const BAR_TITLE_TO = 48;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10 },
});
