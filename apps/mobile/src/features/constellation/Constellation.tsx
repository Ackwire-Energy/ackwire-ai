import { AGENT_GRADIENTS, type AgentColorName } from "@agenteschat/ui/agent/engine";
import { Canvas, Path, Skia } from "@shopify/react-native-skia";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, Pressable, Text as RNText, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useLivePaused } from "@/agent/live";
import { Dither } from "@/sky/Dither";
import { Icon, Text } from "@/ui";
import { useReducedMotion } from "@/ui/theme";
import { Face } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import {
  frameStars,
  namedStars,
  type Point,
  pixelsAlong,
  placeStars,
  ringAround,
  type Star,
  type StarLink,
  type StarMap,
  spriteOf,
  worldSide,
} from "./logic";

/** The night stays in both themes: the stars need the dark. */
const NIGHT = "#070b14";
const NIGHT_TONES = ["#070b14", "#0a1120", "#0c1a35", "#0f2750"] as const;
const LINE = "#88a9e6";
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.8;
const FOCUS = { duration: 420, easing: Easing.out(Easing.cubic) };

/** A path of small squares, for what is drawn in one color. */
function squares(points: Point[], size: number) {
  const path = Skia.PathBuilder.Make();
  for (const p of points) path.addRect(Skia.XYWHRect(p.x, p.y, size, size));
  return path.build();
}

/** A light that passes along the links used lately, one at a time. */
function Pulse({ links, at }: { links: StarLink[]; at: Map<string, Point> }) {
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  const progress = useSharedValue(0);
  const [link, setLink] = useState<StarLink | null>(null);
  const turn = useRef(0);
  const moving = !reduced && !paused && links.length > 0;
  useEffect(() => {
    if (!moving) {
      setLink(null);
      return;
    }
    const next = () => {
      turn.current += 1;
      setLink(links[turn.current % links.length] ?? null);
      progress.value = 0;
      progress.value = withTiming(1, { duration: 1400, easing: Easing.linear });
    };
    next();
    const timer = setInterval(next, 1900);
    return () => clearInterval(timer);
  }, [moving, links, progress]);
  const a = link ? at.get(link.from) : undefined;
  const b = link ? at.get(link.to) : undefined;
  const style = useAnimatedStyle(() => {
    if (!a || !b) return { opacity: 0 };
    return {
      opacity: 1 - progress.value ** 4,
      transform: [
        { translateX: a.x + (b.x - a.x) * progress.value - 2 },
        { translateY: a.y + (b.y - a.y) * progress.value - 2 },
      ],
    };
  });
  return <Animated.View pointerEvents="none" style={[styles.pulse, style]} />;
}

/** One star: its pixels are on the canvas; this is the tap, the agent's body, the ring when selected and the name. */
function StarSpot({
  star,
  at,
  named,
  selected,
  onPress,
}: {
  star: Star;
  at: Point;
  named: boolean;
  selected: boolean;
  onPress: ((id: string) => void) | undefined;
}) {
  const agent = star.kind === "agent";
  const body = agent ? 34 : 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={star.title}
      accessibilityState={{ selected }}
      disabled={!onPress}
      onPress={() => onPress?.(star.id)}
      style={[styles.spot, { left: at.x - SPOT / 2, top: at.y - SPOT / 2 }]}
    >
      {agent ? <Face who={{ type: "agent", id: star.id }} size={body} /> : null}
      {named || selected ? (
        <View style={[styles.name, { top: SPOT / 2 + (agent ? body / 2 + 3 : 9) }]} pointerEvents="none">
          <RNText
            numberOfLines={2}
            maxFontSizeMultiplier={1.2}
            style={[styles.nameText, (agent || selected) && styles.nameStrong]}
          >
            {star.title}
          </RNText>
        </View>
      ) : null}
    </Pressable>
  );
}

export interface ConstellationProps {
  map: StarMap;
  selected: string | null;
  height: number;
  /** Tapping a star; without it the sky is only to look at (no drag, no zoom). */
  onSelect?: (id: string) => void;
}

/**
 * The sky: a world bigger than the window, dragged and pinched, with the selected star brought to the middle.
 * Lines and stars are one Skia drawing; bodies, names and taps are views on top, moved with it, so the screen reader
 * reaches every star.
 */
export function Constellation({ map, selected, height, onSelect }: ConstellationProps) {
  const dir = useDirectory();
  const at = useMemo(() => placeStars(map), [map]);
  const side = worldSide(map.stars.length);
  const named = useMemo(() => namedStars(map, at, selected), [map, at, selected]);
  const recent = useMemo(() => map.links.filter((l) => l.recent), [map]);
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const zoom = useSharedValue(1);
  const placed = useRef(false);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  useEffect(() => {
    if (!width) return;
    // Only to look at: every star in the frame. To explore: the selected star in the middle.
    const framed = onSelect || at.size === 0 ? null : frameStars(at, width, height);
    if (framed) zoom.value = framed.zoom;
    const p = framed?.center ?? (selected ? at.get(selected) : undefined) ?? { x: side / 2, y: side / 2 };
    const toX = width / 2 - p.x * zoom.value;
    const toY = height / 2 - p.y * zoom.value;
    x.value = placed.current ? withTiming(toX, FOCUS) : toX;
    y.value = placed.current ? withTiming(toY, FOCUS) : toY;
    placed.current = true;
  }, [selected, at, width, height, side, x, y, zoom, onSelect]);

  const art = useMemo(() => {
    const line = (hot: boolean) =>
      map.links.flatMap((l) => {
        const a = at.get(l.from);
        const b = at.get(l.to);
        if (!a || !b || (l.from === selected || l.to === selected) !== hot) return [];
        return pixelsAlong(a, b);
      });
    const white: Point[] = [];
    const tinted = new Map<AgentColorName, Point[]>();
    for (const s of map.stars) {
      const p = at.get(s.id);
      if (!p || s.kind === "agent") continue;
      const cell = 2;
      const list = s.kind === "page" ? white : (tinted.get(agentColor(s, dir)) ?? []);
      for (const [dx, dy] of spriteOf(s.kind)) list.push({ x: p.x + dx * cell - 1, y: p.y + dy * cell - 1 });
      if (s.kind === "memory") tinted.set(agentColor(s, dir), list);
    }
    const chosen = map.stars.find((s) => s.id === selected);
    const spot = chosen ? at.get(chosen.id) : undefined;
    return {
      ring: squares(spot && chosen ? ringAround(spot, chosen.kind === "agent" ? 27 : 14) : [], 2),
      dim: squares(line(false), 1.5),
      hot: squares(line(true), 2),
      white: squares(white, 2),
      tinted: [...tinted].map(([color, pts]) => ({ color: AGENT_GRADIENTS[color][0], path: squares(pts, 2) })),
    };
  }, [map, at, selected, dir]);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .minDistance(6)
      .onChange((e) => {
        x.value += e.changeX;
        y.value += e.changeY;
      });
    const pinch = Gesture.Pinch().onChange((e) => {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom.value * e.scaleChange));
      const ratio = next / zoom.value;
      x.value = e.focalX - (e.focalX - x.value) * ratio;
      y.value = e.focalY - (e.focalY - y.value) * ratio;
      zoom.value = next;
    });
    return Gesture.Simultaneous(pan, pinch);
  }, [x, y, zoom]);

  const world = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: zoom.value }],
  }));

  const sky = (
    <View onLayout={onLayout} style={[styles.window, { height }]}>
      <Dither kind="sky" tones={NIGHT_TONES} pixel={4} style={StyleSheet.absoluteFill} />
      <Animated.View style={[styles.world, { width: side, height: side }, world]}>
        <Canvas style={{ width: side, height: side }} pointerEvents="none">
          <Path path={art.dim} color={LINE} opacity={0.26} />
          <Path path={art.hot} color={LINE} opacity={0.85} />
          <Path path={art.white} color="#ffffff" />
          <Path path={art.ring} color="#ffffff" />
          {art.tinted.map((t) => (
            <Path key={t.color} path={t.path} color={t.color} />
          ))}
        </Canvas>
        <Pulse links={recent} at={at} />
        {map.stars.map((s) => {
          const p = at.get(s.id);
          return p ? (
            <StarSpot
              key={s.id}
              star={s}
              at={p}
              named={named.has(s.id)}
              selected={s.id === selected}
              onPress={onSelect}
            />
          ) : null;
        })}
      </Animated.View>
    </View>
  );
  return onSelect ? <GestureDetector gesture={gesture}>{sky}</GestureDetector> : sky;
}

function agentColor(s: Star, dir: ReturnType<typeof useDirectory>): AgentColorName {
  return agentLook(s.agentId ? dir.anyAgent(s.agentId) : undefined).color;
}

/** The sky in a card: its name and count on top, and under it what was tapped, which opens. */
export function StarCard({
  label,
  count,
  map,
  selected,
  height = 340,
  onSelect,
  title,
  subtitle,
  onOpen,
}: {
  label: string;
  count: number;
  map: StarMap;
  selected: string | null;
  height?: number;
  onSelect: (id: string) => void;
  title: string;
  subtitle: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.card}>
      <Constellation map={map} selected={selected} height={height} onSelect={onSelect} />
      <View style={styles.cardHead} pointerEvents="none">
        <Icon name="sparkle" size={16} color="#ffffff" />
        <Text variant="callout" style={styles.cardTitle} numberOfLines={1}>
          {label}
        </Text>
        <Text variant="subhead" style={styles.cardCount}>
          {count}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={t("mobile.constellation.openHint")}
        onPress={onOpen}
        style={({ pressed }) => [styles.foot, pressed && styles.pressed]}
      >
        <View style={styles.footText}>
          <Text variant="body" style={styles.footTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text variant="footnote" style={styles.footSub} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Icon name="right" size={16} color="rgba(255,255,255,0.55)" />
      </Pressable>
    </View>
  );
}

/** A small sky to look at, over a page or a memory. */
export function StarStrip({ map, selected }: { map: StarMap; selected: string }) {
  return (
    <View style={styles.strip}>
      <Constellation map={map} selected={selected} height={170} />
    </View>
  );
}

const SPOT = 44;

const styles = StyleSheet.create({
  window: { overflow: "hidden", backgroundColor: NIGHT },
  world: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" },
  spot: { position: "absolute", width: SPOT, height: SPOT, alignItems: "center", justifyContent: "center" },
  name: {
    position: "absolute",
    width: 112,
    left: (SPOT - 112) / 2,
    alignItems: "center",
  },
  nameText: {
    color: "rgba(255,255,255,0.84)",
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "500",
    textAlign: "center",
    backgroundColor: "rgba(7,11,20,0.62)",
    borderRadius: 5,
    overflow: "hidden",
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  nameStrong: { color: "#ffffff", fontWeight: "600" },
  pulse: { position: "absolute", left: 0, top: 0, width: 4, height: 4, backgroundColor: "#cfe0ff" },
  card: { marginHorizontal: 16, marginTop: 12, borderRadius: 24, overflow: "hidden", backgroundColor: NIGHT },
  cardHead: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 13,
    paddingBottom: 18,
  },
  cardTitle: { flex: 1, color: "#ffffff", fontWeight: "600" },
  cardCount: { color: "rgba(255,255,255,0.62)" },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.14)",
  },
  footText: { flex: 1, minWidth: 0, gap: 1 },
  footTitle: { color: "#ffffff", fontWeight: "600" },
  footSub: { color: "rgba(255,255,255,0.66)" },
  pressed: { opacity: 0.8 },
  strip: { marginHorizontal: 16, marginTop: 8, borderRadius: 20, overflow: "hidden", backgroundColor: NIGHT },
});
