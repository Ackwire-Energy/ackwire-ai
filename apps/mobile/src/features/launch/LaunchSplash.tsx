import { drawAgent, spriteGrid } from "@agenteschat/ui/agent/engine";
import {
  Canvas,
  createPicture,
  Fill,
  Group,
  Path,
  Picture,
  Shader,
  Skia,
  type SkPath,
  useClock,
} from "@shopify/react-native-skia";
import { useNetworkState } from "expo-network";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { frameClock } from "@/agent/clock";
import { useFrameTime } from "@/agent/live";
import { asCtx, compile, RecordingContext, rectsToSvg } from "@/agent/recorder";
import { replay } from "@/agent/skia-ctx";
import { effectOf } from "@/sky/Dither";
import { paletteUniform } from "@/sky/math";
import { Text } from "@/ui";
import { fonts, useReducedMotion, useTheme } from "@/ui/theme";
import {
  LAUNCH,
  LOGO,
  LOGO_LOOK,
  launchPose,
  launchSkyTones,
  SPRITE_BODY,
  SPRITES,
  spriteBlinks,
  spriteY,
  waitLine,
} from "./logic";

/** The agent's canvas: room around the body for the turn and the breath. */
const BOX = Math.ceil(LOGO * 1.5);
const PAD = (BOX - LOGO) / 2;
/** Points per sky cell (the sprites stand on the same grid). */
const PX = 4;
const SPRITE_CELLS = 9;

export interface LaunchSplashProps {
  /** The session and the organization are known: it may leave (after its minimum). */
  ready: boolean;
  /** The brand fonts are in (the name waits for them). */
  fontsReady: boolean;
  /** Its first frame is up: the native launch image can go (they look the same). */
  onShown: () => void;
  /** It is gone. */
  onDone: () => void;
}

/**
 * Opening the app (telas/SplashApp.html, B · Céu sobe). It starts exactly on the native launch image (the logo
 * agent centered, 120 pt image), then the pixel sky rises from the bottom with little agents going up in it,
 * the agent lifts and looks at them, and the name comes in. Once the app is ready (and at least 0.9 s have
 * played) the agent and the name go up and out, the sky sinks and the screen fades into the app. Slow: one
 * line says it's connecting; no network: one line says so. Reduced motion: the logo still, a short fade.
 */
export function LaunchSplash({ ready, fontsReady, onShown, onDone }: LaunchSplashProps) {
  const { t } = useTranslation();
  const { colors: c, scheme } = useTheme();
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const network = useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;

  // Its own timers (the agents' clock can start paused): the minimum, and when to say why it waits.
  const [played, setPlayed] = useState(reduced);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const min = setTimeout(() => setPlayed(true), LAUNCH.min * 1000);
    const why = setTimeout(() => setLate(true), LAUNCH.lineAfter * 1000);
    return () => {
      clearTimeout(min);
      clearTimeout(why);
    };
  }, []);
  // Once it starts leaving it goes, whatever happens next.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (ready && played) setLeaving(true);
  }, [ready, played]);
  const line = leaving ? null : waitLine(late, offline);

  const level = useSharedValue(0);
  const lift = useSharedValue(0);
  const away = useSharedValue(0);
  const name = useSharedValue(0);
  const lineIn = useSharedValue(0);
  const shown = useSharedValue(1);

  useEffect(() => {
    if (reduced) return;
    const rise = { duration: LAUNCH.rise * 1000, easing: Easing.out(Easing.cubic) };
    level.value = withTiming(LAUNCH.sky, rise);
    lift.value = withTiming(1, rise);
    name.value = withDelay(LAUNCH.nameAt * 1000, withTiming(1, { duration: 350 }));
  }, [reduced, level, lift, name]);

  useEffect(() => {
    lineIn.value = withTiming(line ? 1 : 0, { duration: 300 });
  }, [line, lineIn]);

  const done = useRef(onDone);
  done.current = onDone;
  const finish = useCallback(() => done.current(), []);
  useEffect(() => {
    if (!leaving) return;
    const end = (finished?: boolean) => {
      "worklet";
      if (finished) scheduleOnRN(finish);
    };
    if (reduced) {
      shown.value = withTiming(0, { duration: LAUNCH.reducedExit * 1000 }, end);
      return;
    }
    const ms = LAUNCH.exit * 1000;
    away.value = withTiming(1, { duration: ms * 0.4, easing: Easing.inOut(Easing.quad) });
    level.value = withTiming(0, { duration: ms, easing: Easing.inOut(Easing.cubic) });
    shown.value = withDelay(ms * 0.3, withTiming(0, { duration: ms * 0.7, easing: Easing.inOut(Easing.quad) }, end));
  }, [leaving, reduced, away, level, shown, finish]);

  // The native image goes once this first frame is laid out (it looks the same).
  const shownOnce = useRef(false);
  const onLayout = () => {
    if (shownOnce.current) return;
    shownOnce.current = true;
    requestAnimationFrame(onShown);
  };

  // The agent: drawn by the shared engine ~25 times a second, its pose from the choreography.
  const now = useFrameTime(!reduced, 0);
  const [t0] = useState(() => frameClock.time());
  const a = reduced ? 0 : Math.max(0, now - t0);
  const picture = useMemo(() => {
    const rec = new RecordingContext();
    drawAgent(asCtx(rec), PAD, PAD, LOGO, {
      color: LOGO_LOOK.color,
      eyes: LOGO_LOOK.eyes,
      pose: reduced ? {} : launchPose(a, { offline, leaving }),
    });
    const ops = compile(rec.commands);
    return createPicture((canvas) => replay(canvas, ops), { width: BOX, height: BOX });
  }, [a, offline, leaving, reduced]);

  const overlay = useAnimatedStyle(() => ({ opacity: shown.value }));
  const mark = useAnimatedStyle(() => ({
    opacity: 1 - away.value,
    transform: [{ translateY: -LAUNCH.lift * lift.value - 40 * away.value }, { scale: 1 - 0.15 * away.value }],
  }));
  const nameStyle = useAnimatedStyle(() => ({ opacity: name.value }));
  const lineStyle = useAnimatedStyle(() => ({ opacity: lineIn.value }));
  const tones = useMemo(() => launchSkyTones(c.bg, scheme === "dark"), [c.bg, scheme]);
  const lineText = line ? t(`mobile.splash.${line}`) : "";

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }, overlay]}
      pointerEvents={leaving ? "none" : "auto"}
      onLayout={onLayout}
      accessible
      accessibilityLabel={lineText ? `agentes.chat. ${lineText}` : "agentes.chat"}
      accessibilityLiveRegion="polite"
    >
      {reduced ? null : <LaunchSky width={width} height={height} level={level} tones={tones} />}
      <Animated.View
        style={[styles.mark, { left: width / 2 - BOX / 2, top: height / 2 - BOX / 2 }, mark]}
        pointerEvents="none"
      >
        <Canvas style={styles.agent}>
          <Picture picture={picture} />
        </Canvas>
        {fontsReady ? (
          <Animated.View style={[styles.name, reduced ? styles.still : nameStyle]}>
            <RNText allowFontScaling={false} style={[styles.word, { color: c.ink }]}>
              agentes
              <RNText allowFontScaling={false} style={styles.dot}>
                .chat
              </RNText>
            </RNText>
          </Animated.View>
        ) : null}
        <Animated.View style={[styles.line, lineStyle]}>
          <Text variant="callout" tone="muted" style={styles.center}>
            {lineText}
          </Text>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

/**
 * The sky rising to `level`, and the little agents going up in it (all on the UI thread; memo: the agent's
 * frames above don't touch it).
 */
const LaunchSky = memo(function LaunchSky({
  width,
  height,
  level,
  tones,
}: {
  width: number;
  height: number;
  level: SharedValue<number>;
  tones: string[];
}) {
  const effect = effectOf("horizon");
  const clock = useClock();
  const { pal, last } = useMemo(() => paletteUniform(tones), [tones]);
  const uniforms = useDerivedValue(() => ({
    size: [width, height],
    px: PX,
    t: clock.value / 1000,
    last,
    fade: 2,
    clear: 0,
    pal,
    level: level.value,
  }));
  const paths = useMemo(() => {
    const grid = spriteGrid(SPRITE_CELLS);
    const cells = (ch: string) =>
      grid.flatMap((row, y) => [...row].flatMap((cell, x) => (cell === ch ? [x * PX, y * PX, PX, PX] : [])));
    return {
      body: Skia.Path.MakeFromSVGString(rectsToSvg(cells("X"))),
      eyes: Skia.Path.MakeFromSVGString(rectsToSvg(cells("o"))),
    };
  }, []);
  if (!effect) return null;
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Fill>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
      {paths.body && paths.eyes
        ? SPRITES.map((sprite) => (
            <Sprite
              key={sprite.x}
              sprite={sprite}
              clock={clock}
              level={level}
              width={width}
              height={height}
              body={paths.body as SkPath}
              eyes={paths.eyes as SkPath}
            />
          ))
        : null}
    </Canvas>
  );
});

function Sprite({
  sprite,
  clock,
  level,
  width,
  height,
  body,
  eyes,
}: {
  sprite: (typeof SPRITES)[number];
  clock: SharedValue<number>;
  level: SharedValue<number>;
  width: number;
  height: number;
  body: SkPath;
  eyes: SkPath;
}) {
  // On the sky's grid, like the prototype's sprites.
  const x = Math.round((sprite.x * (width - SPRITE_CELLS * PX)) / PX) * PX;
  const transform = useDerivedValue(() => {
    const y = spriteY(sprite, clock.value / 1000, level.value);
    return [{ translateX: x }, { translateY: y === null ? -100 : Math.round((y * height) / PX) * PX }];
  });
  const opacity = useDerivedValue(() => (spriteY(sprite, clock.value / 1000, level.value) === null ? 0 : 1));
  const eyeColor = useDerivedValue(() => (spriteBlinks(sprite, clock.value / 1000) ? SPRITE_BODY : "#ffffff"));
  return (
    <Group transform={transform} opacity={opacity}>
      <Path path={body} color={SPRITE_BODY} />
      <Path path={eyes} color={eyeColor} />
    </Group>
  );
}

const styles = StyleSheet.create({
  mark: { position: "absolute", width: BOX, height: BOX },
  agent: { width: BOX, height: BOX },
  // Under the body (the canvas has room around it), centered on the agent.
  name: { position: "absolute", top: PAD + LOGO + 18, left: BOX / 2 - 160, width: 320, alignItems: "center" },
  word: { fontFamily: fonts.display, fontSize: 30, lineHeight: 38 },
  dot: { fontFamily: fonts.dot, fontSize: 27 },
  line: { position: "absolute", top: PAD + LOGO + 64, left: BOX / 2 - 160, width: 320, alignItems: "center" },
  center: { textAlign: "center" },
  still: { opacity: 1 },
});
