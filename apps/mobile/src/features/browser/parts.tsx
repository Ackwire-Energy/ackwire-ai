import {
  type BrowserFrame,
  type BrowserInputEvent,
  clickEvents,
  createBrowserLiveConnection,
  fitFrame,
  frameMetadata,
  framePoint,
  keyEvents,
  textEvent,
} from "@agenteschat/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, type LayoutChangeEvent, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Icon, Text } from "@/ui";
import { useColors, useConnection } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { LIVE_KEYS, type LiveKey, type PageGap } from "./logic";

/** Why the page can't be shown: the server's reason, or the stream ended / not allowed. */
export type Unavailable = PageGap | null;

/** The page as a picture; a tap on it clicks the page (only for the person in control). */
export function FrameView({
  frame,
  enabled,
  onInput,
}: {
  frame: BrowserFrame;
  enabled: boolean;
  onInput: (events: BrowserInputEvent[]) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) =>
    setView({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  return (
    <Pressable
      style={styles.frame}
      onLayout={onLayout}
      disabled={!enabled}
      accessibilityLabel={t("mobile.browser.live.page")}
      onPress={(e) => {
        // The picture is drawn "contain": a tap on the letterbox around it is ignored.
        const meta = frameMetadata(frame);
        const fit = fitFrame(view, meta);
        const p = framePoint(
          { x: e.nativeEvent.locationX - fit.left, y: e.nativeEvent.locationY - fit.top },
          fit,
          meta,
        );
        if (!p) return;
        tapHaptic();
        onInput(clickEvents(p));
      }}
    >
      <Image
        source={{ uri: `data:image/jpeg;base64,${frame.data}` }}
        style={StyleSheet.absoluteFill}
        resizeMode="contain"
        fadeDuration={0}
      />
    </Pressable>
  );
}

/** The keycaps (symbols; the key names are their labels), as on the web. */
const KEYCAP: Record<LiveKey, string> = { Tab: "⇥", Enter: "↵", Backspace: "⌫", Escape: "esc" };

/**
 * Typing into the page: one quiet field like the composer, whole text into
 * the page's focused field (tap it on the page first). The lock hides it and makes it a password field,
 * so the phone offers the saved passwords; the keyboard button shows the special keys; send is round.
 */
export function TypeBar({ onInput }: { onInput: (events: BrowserInputEvent[]) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const [text, setText] = useState("");
  const [secret, setSecret] = useState(false);
  const [keys, setKeys] = useState(false);
  const send = () => {
    const event = textEvent(text);
    if (!event) return;
    onInput([event]);
    setText("");
  };
  const key = (k: LiveKey) => {
    tapHaptic();
    onInput(keyEvents(k));
  };
  const tool = (on: boolean) => [styles.tool, { backgroundColor: on ? c.sunken : "transparent" }];
  return (
    <View style={styles.typeWrap}>
      {keys ? (
        <View style={styles.keys} accessibilityLabel={t("mobile.browser.live.keys")}>
          {LIVE_KEYS.map((k) => (
            <Pressable
              key={k}
              onPress={() => key(k)}
              accessibilityRole="button"
              accessibilityLabel={t(`mobile.browser.live.key.${k}`)}
              style={[styles.keyCap, { backgroundColor: c.sunken }]}
            >
              <Text variant="footnote" tone="ink2" style={styles.medium}>
                {KEYCAP[k]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={[styles.field, { backgroundColor: c.raised, borderColor: c.line }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={secret ? t("mobile.browser.live.typeMarkedSecret") : t("mobile.browser.live.typeMarked")}
          placeholderTextColor={c.faint}
          style={[styles.input, { color: c.ink }]}
          secureTextEntry={secret}
          textContentType={secret ? "password" : "none"}
          autoComplete={secret ? "current-password" : "off"}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={send}
          submitBehavior="submit"
        />
        <Pressable
          onPress={() => setSecret((s) => !s)}
          accessibilityRole="switch"
          accessibilityState={{ checked: secret }}
          accessibilityLabel={secret ? t("mobile.browser.live.secureOn") : t("mobile.browser.live.secureOff")}
          hitSlop={4}
          style={tool(secret)}
        >
          <Icon name="lock" size={17} color={secret ? c.ink : c.muted} />
        </Pressable>
        <Pressable
          onPress={() => setKeys((k) => !k)}
          accessibilityRole="button"
          accessibilityState={{ expanded: keys }}
          accessibilityLabel={t("mobile.browser.live.keys")}
          hitSlop={4}
          style={tool(keys)}
        >
          <Icon name="keyboard" size={17} color={keys ? c.ink : c.muted} />
        </Pressable>
        <Pressable
          onPress={send}
          disabled={!text}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.browser.live.send")}
          style={({ pressed }) => [styles.send, { backgroundColor: c.ink, opacity: !text ? 0.35 : pressed ? 0.8 : 1 }]}
        >
          <Icon name="send" size={16} color={c.bg} />
        </Pressable>
      </View>
    </View>
  );
}

export interface LiveState {
  frame: BrowserFrame | null;
  unavailable: Unavailable;
  controllerUserId: string | null;
  /** The handoff the last status carried (undefined until a status arrives). */
  handoff: { controllerUserId: string | null } | null | undefined;
  /** Someone else is in control: no page reaches this view until they hand it back. */
  hidden: boolean;
  sendInput: (events: BrowserInputEvent[]) => void;
}

/**
 * Watches the agent's browser on the app's realtime socket while `enabled` (the card is open), as the
 * web's `useBrowserLive`: frames, who is in control, why it can't be shown. Watches again after the
 * socket reconnects; the shared connection retries on its own while the computer is "reconnecting".
 */
export function useLiveConnection(agentId: string, enabled: boolean): LiveState {
  const connection = useConnection();
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [unavailable, setUnavailable] = useState<Unavailable>(null);
  const [controllerUserId, setControllerUserId] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<{ controllerUserId: string | null } | null | undefined>(undefined);
  const [hidden, setHidden] = useState(false);
  const liveRef = useRef<ReturnType<typeof createBrowserLiveConnection> | null>(null);

  useEffect(() => {
    if (!connection || !enabled) return;
    const live = createBrowserLiveConnection({
      send: (frameOut) => connection.sendBrowserFrame(frameOut),
      // Shared per socket: one watch per agent however often the card re-renders or remounts.
      watcher: connection.browserWatcher,
      agentId,
      onFrame: (f) => {
        setUnavailable(null);
        setFrame(f);
      },
      onStatus: (st) => {
        // Every retry on a closed browser gets a status first: only a frame says it's open again.
        setUnavailable((u) => (u === "closed" || u === "ended" ? u : null));
        setControllerUserId(st.controllerUserId);
        setHandoff(st.handoff ? { controllerUserId: st.handoff.controllerUserId } : null);
        setHidden(st.hidden);
        // What the person in control does isn't ours to keep on screen either.
        if (st.hidden) setFrame(null);
      },
      onUnavailable: (reason) => setUnavailable(reason),
      onEnded: () => setUnavailable("ended"),
      onError: (code) => {
        if (code === "forbidden" || code === "not_found") setUnavailable("forbidden");
      },
    });
    liveRef.current = live;
    const offFrames = connection.onBrowserFrame((m) => live.handleMessage(m));
    // The server forgets the watch when the socket drops: watch again once it is back.
    const offStatus = connection.onStatus((status) => {
      if (status === "open") live.resume();
      else if (status === "reconnecting")
        setUnavailable((u) => (u === "ended" || u === "forbidden" ? u : "reconnecting"));
    });
    if (connection.isOpen) live.start();
    return () => {
      offFrames();
      offStatus();
      live.close();
      liveRef.current = null;
      // Unwatched, the rest goes stale (the last frame stays as the card's picture).
      setUnavailable(null);
      setControllerUserId(null);
      setHandoff(undefined);
      setHidden(false);
    };
  }, [connection, agentId, enabled]);

  const sendInput = useCallback((events: BrowserInputEvent[]) => {
    liveRef.current?.sendInput(events);
  }, []);
  return { frame, unavailable, controllerUserId, handoff, hidden, sendInput };
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  medium: { fontWeight: "500" },
  typeWrap: { gap: 8 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 14,
    paddingRight: 5,
    minHeight: 44,
  },
  input: { flex: 1, fontSize: 17, paddingVertical: 10 },
  tool: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", marginLeft: 2 },
  keys: { flexDirection: "row", gap: 6, justifyContent: "flex-end" },
  keyCap: { minWidth: 44, alignItems: "center", paddingVertical: 7, paddingHorizontal: 8, borderRadius: 9 },
});
