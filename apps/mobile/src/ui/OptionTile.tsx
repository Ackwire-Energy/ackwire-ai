import type { ReactNode } from "react";
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { useTheme } from "./theme";

/**
 * The web's `OptionCard` (`.ac-option`): a raised choice that, chosen, sinks into the page in light (the sunken
 * face and an inner shadow) and rises in dark, with the ink check in its corner, never a thick ring. In dark the
 * group's other options step back to a hairline (`stepBack`, as the web's single-choice groups).
 */
export function OptionTile({
  pressed,
  onPress,
  children,
  label,
  stepBack = false,
  style,
}: {
  pressed: boolean;
  onPress: () => void;
  children: ReactNode;
  /** What a screen reader says (the tile's words). */
  label: string;
  /** Another option of its group is chosen. */
  stepBack?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, shadows, scheme } = useTheme();
  const dark = scheme === "dark";
  const face = pressed
    ? dark
      ? {
          backgroundColor: mix(colors.raised),
          boxShadow:
            "0px 0px 0px 1px rgba(255, 255, 255, 0.1), 0px 14px 28px -8px rgba(0, 0, 0, 0.8), inset 0px 1px 0px rgba(255, 255, 255, 0.12)",
          transform: [{ translateY: -2 }],
        }
      : {
          backgroundColor: colors.sunken,
          boxShadow: `inset 0px 2px 5px rgba(23, 23, 22, 0.16), inset 0px 1px 1.5px rgba(23, 23, 22, 0.12), inset 0px 0px 0px 1px ${colors.line}`,
        }
    : dark && stepBack
      ? { backgroundColor: "transparent", boxShadow: `inset 0px 0px 0px 1px ${colors.line}` }
      : { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` };
  return (
    <Pressable
      onPress={() => {
        haptics.light();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: pressed }}
      accessibilityLabel={label}
      style={({ pressed: down }) => [styles.tile, face, down && !pressed && styles.down, style]}
    >
      {children}
      {pressed ? (
        <View style={[styles.check, { backgroundColor: colors.ink }]}>
          <Icon name="check" size={11} color={colors.bg} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Dark's chosen face: the raised surface with 7% white (`--chosen-bg`). */
function mix(hex: string): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const ch = (v: number) => Math.round(v + (255 - v) * 0.07);
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

const styles = StyleSheet.create({
  tile: { borderRadius: 16, padding: 12 },
  down: { transform: [{ scale: 0.98 }] },
  check: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
});
