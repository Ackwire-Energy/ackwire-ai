import {
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserLiveUnavailable,
  clickEvents,
  createBrowserLiveConnection,
  fitFrame,
  framePoint,
  keyEvents,
  textEvent,
} from "@agenteschat/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, type LayoutChangeEvent, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text } from "@/ui";
import { useColors, useConnection } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { LIVE_KEYS, type LiveKey } from "./logic";

/** Why the page can't be shown: the server's reason, or the stream ended / not allowed. */
export type Unavailable = BrowserLiveUnavailable | "ended" | null;

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
        const fit = fitFrame(view, frame.metadata);
        const p = framePoint(
          { x: e.nativeEvent.locationX - fit.left, y: e.nativeEvent.locationY - fit.top },
          fit,
          frame.metadata,
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

/**
 * "Digite aqui": the app's own field, whole text into the page's focused field (tap the field on the
 * page first). Senha hides it and makes it a password field, so the phone offers the saved passwords.
 */
export function TypeBar({ onInput }: { onInput: (events: BrowserInputEvent[]) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const [text, setText] = useState("");
  const [secret, setSecret] = useState(false);
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
  return (
    <View style={styles.typeWrap}>
      <View style={[styles.field, { backgroundColor: c.sunken }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t("mobile.browser.live.typeHere")}
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
          accessibilityLabel={t("mobile.browser.live.password")}
          style={[styles.secure, { backgroundColor: secret ? c.raised : "transparent" }]}
        >
          <Text variant="footnote" tone={secret ? "ink" : "muted"} style={styles.medium}>
            {t("mobile.browser.live.password")}
          </Text>
        </Pressable>
      </View>
      <View style={styles.keys}>
        {LIVE_KEYS.map((k) => (
          <Pressable
            key={k}
            onPress={() => key(k)}
            accessibilityRole="button"
            style={[styles.keyBtn, { backgroundColor: c.sunken }]}
          >
            <Text variant="footnote" tone="ink2">
              {t(`mobile.browser.live.key.${k}`)}
            </Text>
          </Pressable>
        ))}
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
        setUnavailable(null);
        setControllerUserId(st.controllerUserId);
        setHandoff(st.handoff ? { controllerUserId: st.handoff.controllerUserId } : null);
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
    };
  }, [connection, agentId, enabled]);

  const sendInput = useCallback((events: BrowserInputEvent[]) => {
    liveRef.current?.sendInput(events);
  }, []);
  return { frame, unavailable, controllerUserId, handoff, sendInput };
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  medium: { fontWeight: "500" },
  typeWrap: { gap: 8 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    paddingLeft: 14,
    paddingRight: 6,
    minHeight: 46,
  },
  input: { flex: 1, fontSize: 17, paddingVertical: 10 },
  secure: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  keys: { flexDirection: "row", gap: 6 },
  keyBtn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 10 },
});
