import {
  type DesktopViewState,
  desktopMode,
  desktopStatusState,
  handoffIsMine,
  handoffMinutesLeft,
  isWaitingHandoff,
  type LiveRun,
  type ScreenStep,
  screenSteps,
  useApi,
  useBrowserHandoffActions,
} from "@agenteschat/client";
import { asksMe, liveSubLine } from "@agenteschat/client/lib/agent-computer";
import { computerName } from "@agenteschat/client/lib/computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { bodyTones } from "@agenteschat/ui/agent/engine";
import { Canvas, Fill, Shader, Skia } from "@shopify/react-native-skia";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Keyboard, type LayoutChangeEvent, StyleSheet, TextInput, View } from "react-native";
import {
  GestureDetector,
  useLongPressGesture,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { scheduleOnRN } from "react-native-worklets";
import { lastCookie } from "@/lib/auth";
import { useServer } from "@/lib/server";
import { readValue, STORED, writeValue } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { rgba } from "@/sky/math";
import { TRACKPAD_SHADER } from "@/sky/shaders";
import { Button, haptics, Icon, IconButton, Text, useReducedMotion, useToast } from "@/ui";
import { useInfoHint } from "@/ui/InfoHint";
import { type LiveKey, stepText } from "../browser/logic";
import { TypeBar } from "../browser/parts";
import { useFinishHandoff } from "../browser/useFinishHandoff";
import { useColors, useDirectory, useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { successHaptic, tapHaptic } from "../shared/parts";
import { useActiveWork } from "../shared/queries";
import { Cover } from "./Cover";
import { PixelCursor } from "./PixelCursor";
import {
  BUTTON,
  PointerLine,
  screenCall,
  screenEvent,
  screenPageStays,
  screenPageUrl,
  sessionCookieScript,
} from "./screen-page";
import {
  atDesktopEdge,
  boundCamera,
  clamp,
  controlScale,
  cursorGain,
  DEFAULT_DESKTOP,
  fitScale,
  followCursor,
  lookAt,
  MAX_SCALE,
  type Size,
  toDesktop,
  WHEEL_STEP,
  zoomCamera,
} from "./screen-view";
import { type PadLesson, padLesson } from "./trackpad";
import type { AgentComputerView } from "./useAgentComputer";

/** How long the screen may stay opening before it says it can't: a socket refused before it opens never closes with a code. */
const STUCK_MS = 30_000;
/** The trackpad's height: a thumb's reach, the rest goes to the screen. */
const PAD_HEIGHT = 224;
/** Points between the trackpad's dots. */
const DOT_GAP = 9;
/** How long a press holds before it drags. */
const HOLD_MS = 320;
/** Points a finger goes before the trackpad follows it: enough that a tap's small roll doesn't move the cursor. */
const SWIPE_START = 3;
/** The closest two ticks of the wheel come under the fingers: faster, the phone only buzzes. */
const NOTCH_HAPTIC_MS = 45;
const CAMERA = { duration: 260 };

/** Everything the camera and the cursor share across the gestures, on the UI thread. */
interface Camera {
  s: SharedValue<number>;
  x: SharedValue<number>;
  y: SharedValue<number>;
  cursorX: SharedValue<number>;
  cursorY: SharedValue<number>;
  box: SharedValue<Size>;
  desk: SharedValue<Size>;
}

/** The lesson's cursor, on top of the real one. */
interface Ghost {
  x: number;
  y: number;
  scale: number;
}
const GHOST_REST: Ghost = { x: 0, y: 0, scale: 1 };

/** Compiled once; null if the device refuses it (the pad still works, plain). */
let padEffect: ReturnType<typeof Skia.RuntimeEffect.Make> | undefined;
function trackpadEffect() {
  if (padEffect === undefined) {
    try {
      padEffect = Skia.RuntimeEffect.Make(TRACKPAD_SHADER);
    } catch {
      padEffect = null;
    }
  }
  return padEffect;
}

function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);
  return active;
}

/**
 * The agent's screen on the phone (ADR 0098), as the web's `DesktopView`: live, watched, or in this person's control.
 * The server's page draws it in a WebView as large as the desktop, moved and zoomed by the UI thread; no touch ever
 * reaches the page. In control the trackpad moves a cursor the app draws, and the view follows it. Leaving the app
 * lets go of the stream and the control's 2 minutes run, as for any person who drops; coming back opens it again.
 */
export function AgentScreen({
  agentId,
  view,
  run,
  canTakeOver,
  banner,
  top,
}: {
  agentId: string;
  view: AgentComputerView;
  run: LiveRun | null;
  /** No hold or pause on it (the server still decides who may). */
  canTakeOver: boolean;
  /** The agent held or its computer paused. */
  banner: ReactNode;
  top: (sub: string, action: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { org, orgId } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const server = useServer();
  const api = useApi();
  const actions = useBrowserHandoffActions(orgId);
  const active = useAppActive();
  const now = useNow(15_000);
  const f = view.facts;
  const status = view.desktopQ.data ?? null;
  const userId = f?.userId ?? "";
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const g = agentGrammar(t, name);

  const web = useRef<WebView<object>>(null);
  const [life, setLife] = useState(0);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<DesktopViewState>("connecting");
  const [stuck, setStuck] = useState(false);
  const [taking, setTaking] = useState(false);
  const [typing, setTyping] = useState(false);
  const [boxSize, setBoxSize] = useState<Size>({ width: 0, height: 0 });
  const [deskSize, setDeskSize] = useState<Size>(DEFAULT_DESKTOP);

  const blocked = status ? desktopStatusState(status, userId) : "connecting";
  const mode = status ? desktopMode(status, userId) : "watch";
  const inControl = mode === "control";
  const connect = blocked === null && active;
  const shown: DesktopViewState = blocked ?? page;
  const live = shown === "live";

  const call = (js: string) => web.current?.injectJavaScript(js);
  const line = useRef(new PointerLine((x, y, buttons) => call(screenCall("pointer", x, y, buttons)))).current;
  useEffect(() => () => line.stop(), [line]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: what the page should be doing, once it can hear
  useEffect(() => {
    if (ready) call(screenCall("set", { connect, mode }));
  }, [ready, connect, mode]);

  useEffect(() => {
    if (!connect || shown !== "connecting") {
      setStuck(false);
      return;
    }
    const id = setTimeout(() => setStuck(true), STUCK_MS);
    return () => clearTimeout(id);
  }, [connect, shown]);

  const s = useSharedValue(0.25);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const cursorX = useSharedValue(DEFAULT_DESKTOP.width / 2);
  const cursorY = useSharedValue(DEFAULT_DESKTOP.height / 2);
  const box = useSharedValue<Size>({ width: 0, height: 0 });
  const desk = useSharedValue<Size>(DEFAULT_DESKTOP);
  const nudge = useSharedValue(1);
  const ghost = useSharedValue<Ghost>(GHOST_REST);
  const camera: Camera = { s, x, y, cursorX, cursorY, box, desk };

  // The whole screen to watch; in control the box filled, around the cursor.
  useEffect(() => {
    if (boxSize.width === 0 || boxSize.height === 0) return;
    box.value = boxSize;
    desk.value = deskSize;
    const scale = inControl ? controlScale(boxSize, deskSize) : fitScale(boxSize, deskSize);
    const to = lookAt({ x: cursorX.value, y: cursorY.value }, scale, boxSize, deskSize);
    s.value = withTiming(scale, CAMERA);
    x.value = withTiming(to.x, CAMERA);
    y.value = withTiming(to.y, CAMERA);
  }, [boxSize, deskSize, inControl, box, desk, cursorX, cursorY, s, x, y]);

  const handoff = f?.handoff ?? null;
  const waiting = handoff && isWaitingHandoff(handoff, now) ? handoff : null;
  const asked = waiting !== null && asksMe(waiting, userId);
  // Whose it is goes by ids, the same rule as the request's card: its owner and who controls computers may help too.
  const mine = waiting !== null && handoffIsMine(waiting, userId, agent?.ownerUserId, can(org, "control_computers"));
  const ask = inControl && handoff?.kind === "ask";
  const doneLabel = ask ? t("mobile.browser.live.done") : t("mobile.browser.live.handBack");
  const { handBack, couldnt } = useFinishHandoff(inControl ? handoff : null, name, doneLabel);

  const take = async () => {
    tapHaptic();
    setTaking(true);
    try {
      if (waiting) await actions.takeControl(waiting.id);
      else if (status?.canControl) await actions.takeover(agentId, run?.runId, "desktop");
      // Whoever may take over the agent's browser but not its screen takes the browser, as on the web.
      else await actions.takeover(agentId, run?.runId);
      await view.desktopQ.refetch();
      successHaptic();
    } catch (err) {
      const busy = (err as { status?: number }).status === 409;
      toast({ title: busy ? t("browser.card.busy") : t("mobile.app.failed"), icon: "x" });
    } finally {
      setTaking(false);
    }
  };

  const person = (id: string) => dir.nameOf({ type: "person", id }) || t("channel.unknownPerson");
  const sub = inControl
    ? t(ask ? "desktop.sub.controlAsked" : "desktop.sub.control", g)
    : shown === "hidden"
      ? t("desktop.sub.hidden", { person: status?.controllerUserId ? person(status.controllerUserId) : "" })
      : live && f
        ? liveSubLine(t, f, { name, person, nowMs: now })
        : "";

  const action = inControl ? (
    <Button variant="secondary" size="sm" icon="check" label={doneLabel} onPress={handBack} />
  ) : waiting && mine ? (
    <Button variant="primary" size="sm" label={t("agentComputer.help")} loading={taking} onPress={() => void take()} />
  ) : live && !status?.controllerUserId && !waiting && canTakeOver && (status?.canControl || f?.browser) ? (
    <Button
      variant="secondary"
      size="sm"
      label={t("browser.watch.takeover")}
      loading={taking}
      onPress={() => void take()}
    />
  ) : null;

  const retry = () => {
    setStuck(false);
    setPage("connecting");
    if (ready) call(screenCall("retry"));
    else setLife((n) => n + 1);
    void view.desktopQ.refetch();
  };
  const again = <Button variant="secondary" size="sm" label={t("desktop.retry")} onPress={retry} />;
  const { color } = agentLook(agent);
  const opening = <Cover fill sky spinner color={color} text={t("agentComputer.state.opening", g)} />;
  const cantShow = (
    <Cover
      fill
      icon="eyeoff"
      text={t("agentComputer.state.unavailable", g)}
      help={t("agentComputer.state.unavailableHelp")}
      action={again}
    />
  );
  const computer = computerName(t, org?.name ?? "", view.machine);
  const covers: Record<Exclude<DesktopViewState, "live">, ReactNode> = {
    connecting: stuck ? cantShow : opening,
    hidden: <Cover fill icon="eyeoff" text={t("browser.inCard.hiddenHelp", g)} />,
    offline: (
      <Cover
        fill
        sky
        spinner
        color={color}
        text={t("agentComputer.state.opening", g)}
        help={t("desktop.state.retrying")}
      />
    ),
    busy: <Cover fill spinner color={color} text={t("desktop.state.busy")} help={t("desktop.state.retrying")} />,
    noRoom: <Cover fill icon="clock" text={t("agentComputer.state.noRoom", { computer })} action={again} />,
    paused: <Cover fill icon="pause" text={t("agentComputer.state.pausedPlain", { computer })} />,
    held: <Cover fill icon="pause" text={t("agentComputer.state.held", g)} help={t("agentComputer.state.heldHelp")} />,
    forbidden: <Cover fill icon="lock" text={t("agentComputer.state.forbidden")} />,
    outdated: <Cover fill icon="eyeoff" text={t("agentComputer.state.outdated", { ...g, computer })} />,
    unavailable: cantShow,
    ended: <Cover fill icon="eyeoff" text={t("desktop.state.ended")} action={again} />,
  };

  const frame = useAnimatedStyle(() => ({
    transform: [{ scale: s.value }, { translateX: -x.value }, { translateY: -y.value }],
  }));
  const pointer = useAnimatedStyle(() => ({
    transform: [
      { translateX: (cursorX.value - x.value) * s.value + ghost.value.x },
      { translateY: (cursorY.value - y.value) * s.value + ghost.value.y },
      { scale: nudge.value * ghost.value.scale },
    ],
  }));

  const moved = (px: number, py: number) => line.move(px, py);
  const pointed = (px: number, py: number) => {
    haptics.selection();
    line.move(px, py);
  };
  const clicked = () => {
    tapHaptic();
    line.click(cursorX.value, cursorY.value);
  };
  const held = (down: boolean) => {
    if (down) haptics.medium();
    else haptics.light();
    line.press(cursorX.value, cursorY.value, down ? BUTTON.left : BUTTON.none);
  };
  const lastNotch = useRef(0);
  const wheeled = (down: boolean) => {
    const at = Date.now();
    if (at - lastNotch.current >= NOTCH_HAPTIC_MS) {
      lastNotch.current = at;
      haptics.selection();
    }
    line.click(cursorX.value, cursorY.value, down ? BUTTON.wheelDown : BUTTON.wheelUp);
  };

  const pinchFrom = useSharedValue(1);
  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      pinchFrom.value = s.value;
    },
    onUpdate: (e) => {
      "worklet";
      const next = clamp(pinchFrom.value * e.scale, fitScale(box.value, desk.value), MAX_SCALE);
      const to = zoomCamera(
        { x: x.value, y: y.value },
        s.value,
        next,
        { x: e.focalX, y: e.focalY },
        box.value,
        desk.value,
      );
      s.value = next;
      x.value = to.x;
      y.value = to.y;
    },
  });
  const panView = usePanGesture({
    maxPointers: 2,
    onUpdate: (e) => {
      "worklet";
      const to = boundCamera(
        x.value - e.changeX / s.value,
        y.value - e.changeY / s.value,
        s.value,
        box.value,
        desk.value,
      );
      x.value = to.x;
      y.value = to.y;
    },
  });
  // A tap on the screen brings the cursor there; the trackpad clicks.
  const tapView = useTapGesture({
    enabled: inControl,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      const to = toDesktop({ x: e.x, y: e.y }, { x: x.value, y: y.value }, s.value, desk.value);
      cursorX.value = to.x;
      cursorY.value = to.y;
      scheduleOnRN(pointed, to.x, to.y);
    },
  });
  const viewGestures = useSimultaneousGestures(pinch, panView, tapView);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBoxSize({ width, height });
  };

  // What taking control means, behind an ⓘ beside "Você no controle", as on the web (ADR 0076).
  const notice = useInfoHint({
    name: t("common.about", { label: t("desktop.session.check") }),
    text: `${t("desktop.control.notice", g)}${f?.edition === "cloud" ? ` ${t("desktop.session.screening")}` : ""}`,
    variant: "footnote",
  });

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      {top(sub, action, inControl ? notice.button : undefined)}
      {inControl ? <View style={styles.notice}>{notice.text}</View> : null}
      {banner}
      {waiting ? (
        <View style={[styles.ask, { backgroundColor: c.sunken }]}>
          <Text variant="small" tone="ink2">
            {t(asked ? "agentComputer.ask.banner" : "agentComputer.ask.bannerOther", {
              ...g,
              ...(asked ? {} : { person: waiting.requestedForUserId ? person(waiting.requestedForUserId) : "" }),
              ask: waiting.instructions,
              count: handoffMinutesLeft(waiting, now) ?? 0,
            })}
          </Text>
        </View>
      ) : null}
      <View
        onLayout={onLayout}
        style={[
          styles.box,
          inControl ? styles.fill : { aspectRatio: deskSize.width / deskSize.height, flexGrow: 0, flexShrink: 1 },
        ]}
        accessibilityRole="image"
        accessibilityLabel={t("agentComputer.screen", g)}
      >
        <GestureDetector gesture={viewGestures}>
          <Animated.View style={StyleSheet.absoluteFill} collapsable={false}>
            <Animated.View
              pointerEvents="none"
              style={[{ width: deskSize.width, height: deskSize.height }, styles.frame, frame]}
            >
              <WebView
                key={life}
                ref={web}
                source={{ uri: screenPageUrl(server, orgId, agentId) }}
                originWhitelist={[new URL(server).origin]}
                onShouldStartLoadWithRequest={(request) => screenPageStays(server, request.url)}
                injectedJavaScriptBeforeContentLoaded={sessionCookieScript(lastCookie(), server)}
                incognito
                javaScriptEnabled
                scrollEnabled={false}
                bounces={false}
                overScrollMode="never"
                textInteractionEnabled={false}
                androidLayerType="hardware"
                style={styles.web}
                onMessage={(e) => {
                  const event = screenEvent(server, e.nativeEvent);
                  if (!event) return;
                  if (event.type === "ready") setReady(true);
                  else if (event.type === "view") setPage(event.state);
                  else if (event.type === "size") setDeskSize({ width: event.width, height: event.height });
                  else if (event.type === "changed") void view.desktopQ.refetch();
                  else toast({ title: t("desktop.clipboard.tooLong", g), icon: "x" });
                }}
                onContentProcessDidTerminate={() => {
                  setReady(false);
                  setLife((n) => n + 1);
                }}
                onRenderProcessGone={() => {
                  setReady(false);
                  setLife((n) => n + 1);
                }}
              />
            </Animated.View>
            {inControl ? (
              <Animated.View pointerEvents="none" style={[styles.cursor, pointer]}>
                <PixelCursor />
              </Animated.View>
            ) : null}
          </Animated.View>
        </GestureDetector>
        {live ? null : covers[shown]}
        {taking ? (
          <View style={styles.taking} pointerEvents="none">
            <Text variant="small" style={styles.takingText}>
              {t("desktop.taking")}
            </Text>
          </View>
        ) : null}
      </View>
      {inControl ? (
        typing ? (
          <TypingBar
            bottom={insets.bottom}
            onText={(text) => call(screenCall("type", text))}
            onKey={(k) => call(screenCall("key", k))}
            onClose={() => {
              setTyping(false);
              Keyboard.dismiss();
            }}
          />
        ) : (
          <View style={[styles.control, { paddingBottom: insets.bottom + 12 }]}>
            <Trackpad
              camera={camera}
              nudge={nudge}
              ghost={ghost}
              color={color}
              onMove={moved}
              onClick={clicked}
              onHold={held}
              onWheel={wheeled}
              onEdge={haptics.firm}
              onKeyboard={() => setTyping(true)}
            />
            {ask ? (
              <Button variant="ghost" size="sm" label={t("mobile.browser.live.couldnt")} onPress={couldnt} />
            ) : null}
          </View>
        )
      ) : (
        <Watching agentId={agentId} name={name} steps={screenSteps(run?.work)} api={api} bottom={insets.bottom} />
      )}
    </KeyboardAvoidingView>
  );
}

/**
 * The person's fingers as a laptop's trackpad: swipe moves, tap clicks, hold drags, two fingers scroll. No words: the
 * dots answer the fingers, and until the first touch a pixel finger shows the gestures.
 */
function Trackpad({
  camera,
  nudge,
  ghost,
  color,
  onMove,
  onClick,
  onHold,
  onWheel,
  onEdge,
  onKeyboard,
}: {
  camera: Camera;
  /** The cursor's scale: it answers a click or a hold. */
  nudge: SharedValue<number>;
  /** The lesson's cursor, drawn only: it never moves the real one. */
  ghost: SharedValue<Ghost>;
  color: Parameters<typeof bodyTones>[0];
  onMove: (x: number, y: number) => void;
  onClick: () => void;
  onHold: (down: boolean) => void;
  onWheel: (down: boolean) => void;
  /** The cursor just reached the desktop's edge. */
  onEdge: () => void;
  onKeyboard: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  const { s, x, y, cursorX, cursorY, box, desk } = camera;
  const wheel = useSharedValue(0);
  const edge = useSharedValue(false);
  const [holding, setHolding] = useState(false);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const padSize = useSharedValue<Size>({ width: 0, height: 0 });
  const demo = useSharedValue<PadLesson | null>(null);
  const taught = useSharedValue(false);
  const spotX = useSharedValue(0);
  const spotY = useSharedValue(0);
  const tailX = useSharedValue(0);
  const tailY = useSharedValue(0);
  const spread = useSharedValue(0);
  const on = useSharedValue(0);
  const ringX = useSharedValue(0);
  const ringY = useSharedValue(0);
  const ringT = useSharedValue(-1);

  const lesson = useFrameCallback((f) => {
    if (taught.value) return;
    const l = padLesson(f.timeSinceFirstFrame / 1000, padSize.value.width, padSize.value.height);
    demo.value = l;
    ghost.value = { x: l.cursorX, y: l.cursorY, scale: l.cursorScale };
  }, false);
  const lessonOver = () => {
    lesson.setActive(false);
    void writeValue(STORED.trackpadTaught, "1");
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lesson starts once, with the pad
  useEffect(() => {
    let alive = true;
    void readValue(STORED.trackpadTaught).then((v) => {
      if (alive && v !== "1" && !reduced) lesson.setActive(true);
    });
    return () => {
      alive = false;
      lesson.setActive(false);
      ghost.value = GHOST_REST;
    };
  }, []);

  const touch = (px: number, py: number) => {
    "worklet";
    if (!taught.value) {
      taught.value = true;
      demo.value = null;
      ghost.value = GHOST_REST;
      scheduleOnRN(lessonOver);
    }
    spotX.value = px;
    spotY.value = py;
    tailX.value = px;
    tailY.value = py;
    spread.value = 0;
    on.value = withTiming(1, { duration: 80 });
  };
  const follow = (px: number, py: number) => {
    "worklet";
    spotX.value = px;
    spotY.value = py;
    tailX.value = withTiming(px, { duration: 220 });
    tailY.value = withTiming(py, { duration: 220 });
  };
  const lift = () => {
    "worklet";
    on.value = withTiming(0, { duration: 280 });
  };

  const swipe = usePanGesture({
    maxPointers: 1,
    minDistance: SWIPE_START,
    onBegin: (e) => {
      "worklet";
      touch(e.x, e.y);
    },
    onUpdate: (e) => {
      "worklet";
      follow(e.x, e.y);
      const gain = cursorGain(Math.hypot(e.velocityX, e.velocityY) / 1000, s.value);
      const d = desk.value;
      cursorX.value = clamp(cursorX.value + e.changeX * gain, 0, d.width);
      cursorY.value = clamp(cursorY.value + e.changeY * gain, 0, d.height);
      const edged = atDesktopEdge({ x: cursorX.value, y: cursorY.value }, d);
      if (edged && !edge.value) scheduleOnRN(onEdge);
      edge.value = edged;
      const to = followCursor(
        { x: x.value, y: y.value },
        s.value,
        { x: cursorX.value, y: cursorY.value },
        box.value,
        d,
      );
      x.value = to.x;
      y.value = to.y;
      scheduleOnRN(onMove, cursorX.value, cursorY.value);
    },
    onFinalize: () => {
      "worklet";
      lift();
    },
  });
  const hold = useLongPressGesture({
    minDuration: HOLD_MS,
    maxDistance: 8,
    onActivate: () => {
      "worklet";
      nudge.value = withTiming(1.14, { duration: 120 });
      scheduleOnRN(setHolding, true);
      scheduleOnRN(onHold, true);
    },
    onDeactivate: () => {
      "worklet";
      nudge.value = withTiming(1, { duration: 120 });
      scheduleOnRN(setHolding, false);
      scheduleOnRN(onHold, false);
    },
  });
  const tap = useTapGesture({
    maxDuration: 260,
    maxDistance: 8,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      nudge.value = withSequence(withTiming(0.84, { duration: 60 }), withTiming(1, { duration: 120 }));
      ringX.value = e.x;
      ringY.value = e.y;
      ringT.value = 0;
      ringT.value = withTiming(1, { duration: 600 });
      scheduleOnRN(onClick);
    },
  });
  const scroll = usePanGesture({
    minPointers: 2,
    maxPointers: 2,
    minDistance: SWIPE_START,
    onBegin: () => {
      "worklet";
      wheel.value = 0;
    },
    onActivate: (e) => {
      "worklet";
      touch(e.x, e.y);
      spread.value = 22;
    },
    onUpdate: (e) => {
      "worklet";
      follow(e.x, e.y);
      wheel.value += e.changeY;
      if (Math.abs(wheel.value) < WHEEL_STEP) return;
      // Fingers going up bring the page's lower part in, as on a phone.
      const down = wheel.value < 0;
      wheel.value += down ? WHEEL_STEP : -WHEEL_STEP;
      scheduleOnRN(onWheel, down);
    },
    onDeactivate: () => {
      "worklet";
      lift();
    },
  });
  const gestures = useSimultaneousGestures(swipe, hold, tap, scroll);

  const source = trackpadEffect();
  const tones = bodyTones(color);
  const dotTone = rgba(c.faint);
  dotTone[3] = 0.32;
  const base = { size: [size.width, size.height], gap: DOT_GAP, dotTone, glowTone: rgba(tones[3] ?? c.ink) };
  const uniforms = useDerivedValue(() => {
    const l = demo.value;
    const px = l ? l.x : spotX.value;
    const py = l ? l.y : spotY.value;
    const ex = l ? l.tailX : tailX.value;
    const ey = l ? l.tailY : tailY.value;
    const apart = l ? l.spread : spread.value;
    return {
      ...base,
      a: [px - apart, py],
      aTail: [ex - apart, ey],
      b: [px + apart, py],
      bTail: [ex + apart, ey],
      on: l ? l.on : on.value,
      two: apart > 0 ? 1 : 0,
      ring: l ? [l.ringX, l.ringY] : [ringX.value, ringY.value],
      ringT: l ? l.ringT : ringT.value,
    };
  });

  return (
    <GestureDetector gesture={gestures}>
      <View
        collapsable={false}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          padSize.value = { width, height };
          setSize({ width, height });
        }}
        style={[styles.pad, { backgroundColor: c.sunken, borderColor: holding ? tones[3] : c.line }]}
        accessibilityLabel={t("agentComputer.phone.trackpad")}
        accessibilityHint={t("agentComputer.phone.trackpadHint")}
      >
        {source && size.width > 0 ? (
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Fill>
              <Shader source={source} uniforms={uniforms} />
            </Fill>
          </Canvas>
        ) : null}
        <View style={styles.padKeyboard}>
          <IconButton icon="keyboard" plate label={t("desktop.keyboard.label")} onPress={onKeyboard} />
        </View>
      </View>
    </GestureDetector>
  );
}

/** The app's own field on the screen, whole texts into the field in focus there, with the keyboard's way back. */
function TypingBar({
  bottom,
  onText,
  onKey,
  onClose,
}: {
  bottom: number;
  onText: (text: string) => void;
  onKey: (key: LiveKey) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={[styles.typing, { paddingBottom: Math.max(bottom, 8) }]}>
      <View style={styles.grow}>
        <TypeBar autoFocus onText={onText} onKey={onKey} />
      </View>
      <IconButton icon="x" plate label={t("mobile.common.close")} onPress={onClose} />
    </View>
  );
}

/** Under the screen while watching: what the agent does now, and a line to it while it works in a conversation. */
function Watching({
  agentId,
  name,
  steps,
  api,
  bottom,
}: {
  agentId: string;
  name: string;
  steps: ScreenStep[];
  api: ReturnType<typeof useApi>;
  bottom: number;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId } = useOrg();
  const toast = useToast();
  const channelId = useActiveWork().find((w) => w.agentId === agentId)?.channelId ?? null;
  const [text, setText] = useState("");
  const send = () => {
    const body = text.trim();
    if (!body || !channelId) return;
    tapHaptic();
    setText("");
    api.chat.post(orgId, channelId, { body }).catch(() => {
      setText(body);
      toast({ title: t("mobile.app.failed"), icon: "x" });
    });
  };
  const recent = steps.slice(-4);
  return (
    <View style={[styles.under, { paddingBottom: bottom + 12 }]}>
      {recent.length > 0 ? (
        <View style={styles.steps}>
          <Text variant="footnote" tone="muted" style={styles.bold}>
            {t("agentComputer.phone.now")}
          </Text>
          {recent.map((step, i) => {
            const latest = i === recent.length - 1;
            return (
              <View key={step.id} style={styles.step}>
                <Icon name={latest ? "person" : "check"} size={15} color={latest ? c.ink : c.faint} />
                <Text variant="small" tone={latest ? "ink" : "ink2"} numberOfLines={1} style={latest && styles.bold}>
                  {stepText(t, step, step.screen)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {channelId ? (
        <View style={[styles.composer, { backgroundColor: c.raised, borderColor: c.line }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t("agentComputer.phone.message", { name })}
            placeholderTextColor={c.faint}
            style={[styles.input, { color: c.ink }]}
            returnKeyType="send"
            onSubmitEditing={send}
            submitBehavior="submit"
          />
          <IconButton icon="send" plate label={t("mobile.browser.live.send")} disabled={!text.trim()} onPress={send} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  notice: { paddingHorizontal: 14 },
  ask: { marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14 },
  box: { marginHorizontal: 12, borderRadius: 18, overflow: "hidden", backgroundColor: "#101010" },
  frame: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" },
  web: { flex: 1, backgroundColor: "transparent" },
  cursor: {
    position: "absolute",
    left: 0,
    top: 0,
    transformOrigin: "left top",
    shadowColor: "#0a0c1e",
    shadowOpacity: 0.45,
    shadowRadius: 1.5,
    shadowOffset: { width: 0, height: 1.5 },
  },
  taking: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15,15,14,0.45)",
  },
  takingText: { color: "#ffffff", fontWeight: "600" },
  control: { paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  pad: {
    height: PAD_HEIGHT,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  padKeyboard: { position: "absolute", right: 10, bottom: 10 },
  typing: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  under: { flex: 1, paddingHorizontal: 14, paddingTop: 12, gap: 12 },
  steps: { gap: 7 },
  step: { flexDirection: "row", alignItems: "center", gap: 9 },
  composer: {
    marginTop: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 46,
    borderRadius: 23,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 16,
    paddingRight: 6,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 8 },
});
