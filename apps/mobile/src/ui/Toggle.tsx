import { useEffect } from "react";
import { Pressable, Text as RNText, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { haptics } from "./haptics";
import { useTheme } from "./theme";

export interface ToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
  /** Shown on the left of the switch (and read by screen readers). */
  label: string;
}

/** A custom switch (never the native one) in a row with its label. */
export function Toggle({ value, onChange, label }: ToggleProps) {
  const { colors, fonts } = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onChange(!value);
      }}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13, paddingHorizontal: 14 }}
    >
      <RNText style={{ flex: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.ink }}>{label}</RNText>
      <ToggleSwitch value={value} />
    </Pressable>
  );
}

/**
 * Only the switch (track and knob), for rows that bring their own press and
 * label (a sheet action with an icon and a hint). The row carries
 * `accessibilityRole="switch"` and the checked state.
 */
export function ToggleSwitch({ value }: { value: boolean }) {
  const { colors, motion, reducedMotion } = useTheme();
  const k = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    k.value = reducedMotion ? withTiming(value ? 1 : 0, { duration: 0 }) : withSpring(value ? 1 : 0, motion.pop);
  }, [value, reducedMotion, motion.pop, k]);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: 18 * k.value }] }));
  return (
    <View
      style={{
        width: 46,
        height: 28,
        borderRadius: 999,
        backgroundColor: value ? colors.ink : colors.sunken,
        boxShadow: "inset 0px 1px 2px 0px rgba(0, 0, 0, 0.1)",
      }}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 3,
            left: 3,
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: value ? colors.bg : colors.raised,
            boxShadow: "0px 1px 3px 0px rgba(0, 0, 0, 0.25)",
          },
          knob,
        ]}
      />
    </View>
  );
}
