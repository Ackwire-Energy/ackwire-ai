import { Canvas, Group, Path, rect, rrect, Skia, type SkPath } from "@shopify/react-native-skia";
import { useState } from "react";
import { type LayoutChangeEvent, StyleSheet, type ViewStyle } from "react-native";
import { type SharedValue, useDerivedValue } from "react-native-reanimated";

const BAR = 3;
const GAP = 2;

/** How many bars fit in `width`. */
export const barsIn = (width: number) => Math.max(1, Math.floor((width + GAP) / (BAR + GAP)));

/**
 * `peaks` as round bars. `tail`: the newest ones at the right end, and quiet dots before them, the way a live
 * recording looks; otherwise spread over the whole width.
 */
export function barsPath(peaks: readonly number[], width: number, height: number, tail = false): SkPath {
  const path = Skia.Path.Make();
  const n = barsIn(width);
  const shown = tail ? peaks.slice(-n) : stretched(peaks, n);
  const startAt = tail ? width - shown.length * (BAR + GAP) + GAP : 0;
  if (tail) {
    for (let x = startAt - BAR - GAP; x > -BAR; x -= BAR + GAP) path.addCircle(x + BAR / 2, height / 2, 1.2);
  }
  shown.forEach((level, i) => {
    const h = Math.max(3, Math.min(height, level * height));
    path.addRRect(rrect(rect(startAt + i * (BAR + GAP), (height - h) / 2, BAR, h), 1.5, 1.5));
  });
  return path;
}

function stretched(peaks: readonly number[], n: number): number[] {
  if (peaks.length === 0) return Array.from({ length: n }, () => 0.06);
  return Array.from({ length: n }, (_, i) => peaks[Math.floor((i * peaks.length) / n)] ?? 0.06);
}

/**
 * A wave drawn by Skia on the UI thread: `path` and `progress` change without a render of anything around it, so a
 * playing or recording wave never touches React.
 */
export function VoiceBars({
  path,
  progress,
  on,
  off,
  onWidth,
  height,
  style,
}: {
  path: SharedValue<SkPath>;
  progress: SharedValue<number>;
  on: string;
  off: string;
  onWidth?: (width: number) => void;
  height: number;
  style?: ViewStyle;
}) {
  const [width, setWidth] = useState(0);
  const layout = (e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.width;
    setWidth(next);
    onWidth?.(next);
  };
  const clip = useDerivedValue(() => rect(0, 0, width * progress.value, height));
  return (
    <Canvas onLayout={layout} style={[styles.canvas, { height }, style]}>
      <Path path={path} color={off} />
      <Group clip={clip}>
        <Path path={path} color={on} />
      </Group>
    </Canvas>
  );
}

const styles = StyleSheet.create({ canvas: { flex: 1, minWidth: 0 } });
