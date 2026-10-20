import { useEffect } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { useReducedMotion, useTheme } from "@/ui/theme";
import { useFrameTime } from "./live";
import { inkOrbitCells, orbitHead, RING, STOP_CELLS, stopTurn } from "./orbit";

/**
 * The pixel marks next to the agent's orbit (Mensagens.html): the neutral orbit ("enviando", "lê na próxima
 * pausa"), a finished step's one green pixel, a stopped step's dim block and the composer's 2×2 stop
 * square. Same grid and gaps as `PixelOrbit`; nothing moves with reduced motion.
 */

const cellBox = (size: number, n: number, x: number, y: number) => {
  const cell = size / n;
  const gap = Math.max(0.5, cell * 0.14);
  return {
    position: "absolute" as const,
    left: x * cell + gap / 2,
    top: y * cell + gap / 2,
    width: cell - gap,
    height: cell - gap,
  };
};

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const };

/** The 3×3 orbit in ink (no agent color): something on its way that isn't an agent's work. */
export function InkOrbit({ size = 12, color }: { size?: number; color?: string }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const t = useFrameTime(!reduced, 0);
  const ink = color ?? colors.muted;
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      {inkOrbitCells(orbitHead(t * 1000, reduced)).map((c) => (
        <View
          key={`${c.x}-${c.y}`}
          style={[cellBox(size, 3, c.x, c.y), { backgroundColor: ink, opacity: c.opacity }]}
        />
      ))}
    </View>
  );
}

/** A finished step: one green pixel, the size of the grid's center cell, popping in (~160 ms). */
export function PixelDone({ size = 14 }: { size?: number }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const k = useSharedValue(reduced ? 1 : 0);
  const pop = useSharedValue(reduced ? 1 : 0.6);
  useEffect(() => {
    if (reduced) return;
    k.value = withTiming(1, { duration: 160 });
    pop.value = withSequence(withTiming(1.15, { duration: 100 }), withTiming(1, { duration: 60 }));
  }, [reduced, k, pop]);
  const style = useAnimatedStyle(() => ({ opacity: k.value, transform: [{ scale: pop.value }] }));
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      <Animated.View style={[cellBox(size, 3, 1, 1), { backgroundColor: colors.ok }, style]} />
    </View>
  );
}

/** A step cut short by a stop: the 3×3 block, dim. */
export function PixelStopped({ size = 14 }: { size?: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      {[...RING, [1, 1] as const].map(([x, y]) => (
        <View key={`${x}-${y}`} style={[cellBox(size, 3, x, y), { backgroundColor: colors.muted, opacity: 0.55 }]} />
      ))}
    </View>
  );
}

/** "Parar": a 2×2 square (reads as stop); one cell dims in turn while the agent works (`moving`). */
export function PixelStop({ size = 13, color, moving = true }: { size?: number; color: string; moving?: boolean }) {
  const reduced = useReducedMotion();
  const still = reduced || !moving;
  const t = useFrameTime(!still, 0);
  const turn = stopTurn(t * 1000, still);
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      {STOP_CELLS.map(([x, y], i) => (
        <View
          key={`${x}-${y}`}
          style={[cellBox(size, 2, x, y), { backgroundColor: color, opacity: i === turn ? 0.55 : 1 }]}
        />
      ))}
    </View>
  );
}
