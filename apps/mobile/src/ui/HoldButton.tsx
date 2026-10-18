import { mixHex } from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BUTTON_SIZES, primaryLook } from "./Button";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export interface HoldButtonProps {
  /** Shown at rest, e.g. "Segure para aprovar". */
  label: string;
  /** Shown while held, e.g. "Segure…". */
  holdLabel: string;
  onConfirm: () => void;
  /** How long to hold (default 1100 ms). */
  durationMs?: number;
}

/**
 * Hold to confirm (high-risk approvals): the button fills from the left while held, ticks a haptic,
 * confirms with a success haptic when full, and cancels when released early.
 */
export function HoldButton({ label, holdLabel, onConfirm, durationMs = 1100 }: HoldButtonProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const look = primaryLook(theme);
  const s = BUTTON_SIZES.md;
  const fill = useSharedValue(0);
  const press = useSharedValue(0);
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const start = () => {
    setHolding(true);
    haptics.light();
    fill.value = withTiming(1, { duration: durationMs, easing: Easing.linear });
    press.value = theme.reducedMotion ? 1 : withSpring(1, theme.motion.press);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      press.value = withTiming(0, { duration: 120 });
      fill.value = withTiming(0, { duration: 250 });
      haptics.success();
      confirmRef.current();
    }, durationMs);
  };
  const stop = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    cancelAnimation(fill);
    fill.value = withTiming(0, { duration: 250, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
    press.value = theme.reducedMotion ? 0 : withSpring(0, theme.motion.press);
  };

  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.03 * press.value }] }));
  const { bg } = theme.colors;

  return (
    <Animated.View
      style={[
        { minHeight: s.height, borderRadius: s.radius, boxShadow: look.shadow, alignSelf: "stretch" },
        pressStyle,
      ]}
    >
      <Pressable
        onPressIn={start}
        onPressOut={stop}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={t("mobile.a11y.hold")}
        style={[styles.face, { borderRadius: s.radius }]}
      >
        <LinearGradient colors={look.gradient} style={StyleSheet.absoluteFill} />
        <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: "left" }, fillStyle]} pointerEvents="none">
          <LinearGradient
            colors={[mixHex(look.gradient[1], bg, 0.22), mixHex(look.gradient[1], bg, 0.34)] as const}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <View style={[styles.edge, { backgroundColor: look.highlight }]} />
        <Icon name="check" size={18} color={look.text} />
        <RNText
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText(s.text, weights.semibold), { color: look.text }]}
        >
          {holding ? holdLabel : label}
        </RNText>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  face: {
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    overflow: "hidden",
  },
  edge: { position: "absolute", left: 0, right: 0, top: 0, height: 1 },
});
