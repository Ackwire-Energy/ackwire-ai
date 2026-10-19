import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { concentricRadius, displayCornerRadius } from "./display-corner";
import { Glass } from "./Glass";
import { useTheme } from "./theme";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
  /** An opaque surface instead of glass (requests to approve, forms). */
  solid?: boolean;
}

/** How far the grabber must be dragged down to close (points), as on the web. */
const CLOSE_DRAG = 90;
/** How far the sheet floats from the screen's edges. */
const INSET = 8;
/** The sheet's top corners (and the least for its bottom ones). */
const RADIUS = 34;

/**
 * The bottom sheet (no dialogs on the phone): floats 8 points from the edges, its bottom corners following
 * the screen's curve, glass on iOS and an opaque surface on Android, a grabber to drag down, a scrim to tap
 * away. Keyboard-aware for forms.
 */
export function Sheet({ open, onClose, children, solid = false }: SheetProps) {
  const { colors, shadows, reducedMotion } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const bottomRadius = concentricRadius(
    displayCornerRadius(Platform.OS === "ios" ? "ios" : "android", width, height, insets.bottom),
    INSET,
    RADIUS,
  );
  const corners = { borderBottomLeftRadius: bottomRadius, borderBottomRightRadius: bottomRadius };
  const [mounted, setMounted] = useState(open);
  const y = useSharedValue(height);
  const scrim = useSharedValue(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const ease = Easing.bezier(0.32, 0.72, 0, 1);
  const ms = reducedMotion ? 0 : 420;

  // Only `open` drives the animation; the rest is read at that moment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only `open` drives the animation
  useEffect(() => {
    if (open) {
      setMounted(true);
      y.value = height;
      y.value = withTiming(0, { duration: ms, easing: ease });
      scrim.value = withTiming(1, { duration: reducedMotion ? 0 : 300 });
    } else if (mounted) {
      scrim.value = withTiming(0, { duration: reducedMotion ? 0 : 250 });
      y.value = withTiming(height, { duration: reducedMotion ? 0 : 320, easing: ease }, (done) => {
        if (done) runOnJS(setMounted)(false);
      });
    }
  }, [open]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => g.dy > 4,
        onPanResponderMove: (_e, g) => {
          y.value = Math.max(0, g.dy);
        },
        onPanResponderRelease: (_e, g) => {
          if (g.dy > CLOSE_DRAG || g.vy > 1.2) closeRef.current();
          else y.value = withTiming(0, { duration: 220, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
        },
        onPanResponderTerminate: () => {
          y.value = withTiming(0, { duration: 220 });
        },
      }),
    [y],
  );

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value }));

  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }, scrimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t("mobile.a11y.closeSheet")} />
      </Animated.View>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.dock}
        pointerEvents="box-none"
      >
        <Animated.View
          accessibilityViewIsModal
          style={[styles.sheet, corners, { maxHeight: height * 0.86, boxShadow: shadows.e3 }, sheetStyle]}
        >
          <Glass solid={solid} intensity={70} style={[styles.surface, corners]}>
            <View
              {...pan.panHandlers}
              style={styles.grab}
              accessibilityRole="adjustable"
              accessibilityLabel={t("mobile.a11y.grabber")}
            >
              <View style={[styles.grabBar, { backgroundColor: colors.line2 }]} />
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 22 + Math.max(0, insets.bottom - INSET) }}
            >
              {children}
            </ScrollView>
          </Glass>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dock: { flex: 1, justifyContent: "flex-end" },
  sheet: { marginHorizontal: INSET, marginBottom: INSET, borderRadius: RADIUS },
  surface: { borderRadius: RADIUS, paddingTop: 8, overflow: "hidden", flexShrink: 1 },
  grab: { alignItems: "center", paddingTop: 4, paddingBottom: 10 },
  grabBar: { width: 38, height: 5, borderRadius: 3 },
});
