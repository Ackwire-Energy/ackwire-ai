import {
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserLiveUnavailable,
  clickEvents,
  createBrowserLiveConnection,
  fitFrame,
  framePoint,
  isOpenHandoff,
  keyEvents,
  textEvent,
  useAgentBrowserHandoff,
  useBrowserHandoff,
  useBrowserHandoffActions,
} from "@agenteschat/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Image, type LayoutChangeEvent, Pressable, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, IconButton, Text, ToastHost, useTheme, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useConnection, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { FAILED_REASONS, hostOf, LIVE_KEYS, type LiveKey } from "./logic";

/**
 * The agent's browser, live and full screen (NavegadorAgente.html, "Tela ao vivo", phone frame): what the
 * agent asked on top, the page as it is now, and, for the person in control, Pronto / Não consegui and the
 * app's own text field (secure for passwords, so the phone offers the saved ones). Tapping the page clicks
 * it. Others watch ("Walter está no controle"). A dropped view keeps the control for 2 minutes.
 */
export function LiveView({ agentId, handoffId }: { agentId: string; handoffId?: string | null }) {
  return (
    <ToastHost>
      <SheetHostProvider>
        <Live agentId={agentId} handoffId={handoffId ?? null} />
      </SheetHostProvider>
    </ToastHost>
  );
}

type Unavailable = BrowserLiveUnavailable | "ended" | null;

function Live({ agentId, handoffId }: { agentId: string; handoffId: string | null }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const sheet = useSheet();
  const actions = useBrowserHandoffActions(orgId);
  const byId = useBrowserHandoff(orgId, handoffId);
  const byAgent = useAgentBrowserHandoff(orgId, agentId);
  const [statusHandoff, setStatusHandoff] = useState<{ controllerUserId: string | null } | null>(null);
  const handoff = (handoffId ? byId.data : byAgent.data) ?? null;
  const name = dir.agentById.get(agentId)?.name ?? "";
  const g = genderOf(name);
  const live = useLiveConnection(agentId);
  const controller = statusHandoff?.controllerUserId ?? live.controllerUserId ?? handoff?.controllerUserId ?? null;
  const mine = Boolean(meId) && controller === meId;
  const open = handoff ? isOpenHandoff(handoff) : false;

  // Opening a request someone asked for takes the control (first one wins; the other sees who).
  const claimed = useRef(false);
  useEffect(() => {
    if (!handoff || claimed.current || handoff.status !== "pending") return;
    claimed.current = true;
    actions.takeControl(handoff.id).catch(() => {});
  }, [handoff, actions]);

  useEffect(() => {
    if (live.handoff !== undefined) setStatusHandoff(live.handoff);
  }, [live.handoff]);

  const finish = async (ok: boolean, note?: string) => {
    if (!handoff) return;
    try {
      if (ok) await actions.done(handoff.id);
      else await actions.failed(handoff.id, note);
      successHaptic();
      goBack();
    } catch {
      toast({ title: t("mobile.app.failed"), icon: "x" });
    }
  };

  const couldnt = () => {
    tapHaptic();
    sheet.open(
      <PromptForm
        title={t("mobile.browser.failed.title")}
        intro={t(`mobile.browser.failed.intro${g}`, { name })}
        placeholder={t("mobile.browser.failed.placeholder")}
        submitLabel={t("mobile.browser.failed.send")}
        allowEmpty
        onSubmit={async (text) => {
          sheet.close();
          await finish(false, text.trim() || undefined);
        }}
      >
        <View style={styles.reasons}>
          {FAILED_REASONS.map((r) => (
            <Button
              key={r}
              variant="secondary"
              size="sm"
              label={t(`mobile.browser.failed.reason.${r}`)}
              onPress={() => {
                sheet.close();
                void finish(false, t(`mobile.browser.failed.reason.${r}`));
              }}
            />
          ))}
        </View>
      </PromptForm>,
    );
  };

  const takeover = async () => {
    tapHaptic();
    try {
      await actions.takeover(agentId);
    } catch {
      toast({ title: t("mobile.app.failed"), icon: "x" });
    }
  };

  const helper = controller ? dir.nameOf({ type: "person", id: controller }) : "";
  const unavailable = live.unavailable;

  return (
    <KeyboardAvoidingView style={[styles.screen, { backgroundColor: colors.bg }]} behavior="padding">
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <IconButton icon="x" plate label={t("mobile.common.close")} onPress={goBack} />
        <AgentFace agentId={agentId} size={26} live={false} />
        <View style={styles.grow} />
        {mine ? (
          <View style={[styles.badge, { backgroundColor: c.sunken }]}>
            <View style={[styles.dot, { backgroundColor: c.ok }]} />
            <Text variant="footnote" tone="ink" style={styles.medium}>
              {t("mobile.browser.live.inControl")}
            </Text>
          </View>
        ) : controller ? (
          <View style={[styles.badge, { backgroundColor: c.sunken }]}>
            <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.medium}>
              {t("mobile.browser.live.helping", { name: helper || t("mobile.chat.someone") })}
            </Text>
          </View>
        ) : null}
      </View>
      {handoff && open ? (
        <View style={styles.ask}>
          <Text variant="caption" tone="muted">
            {t("mobile.browser.live.asked", { name })}
          </Text>
          <Text variant="callout" tone="ink" numberOfLines={3} style={styles.semibold}>
            {handoff.instructions}
          </Text>
        </View>
      ) : null}

      <View style={[styles.page, { backgroundColor: c.sunken }]}>
        {live.frame ? (
          <FrameView frame={live.frame} enabled={mine} onInput={live.sendInput} />
        ) : unavailable ? null : (
          <View style={styles.center}>
            <ActivityIndicator color={c.muted} />
          </View>
        )}
        {unavailable ? (
          <View style={[styles.center, styles.overlay]}>
            {unavailable === "reconnecting" ? <ActivityIndicator color={c.muted} /> : null}
            <Text variant="small" tone="ink" style={styles.semibold}>
              {t(`mobile.browser.live.unavailable.${unavailable}${g}`, { name })}
            </Text>
            {unavailable === "reconnecting" && mine ? (
              <Text variant="caption" tone="muted">
                {t(`mobile.browser.live.grace${g}`, { name })}
              </Text>
            ) : null}
          </View>
        ) : null}
        {live.frame?.metadata.url ? (
          <View style={[styles.url, { backgroundColor: c.raised }]}>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {hostOf(live.frame.metadata.url)}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {mine && handoff ? (
          <>
            <View style={styles.acts}>
              <View style={styles.grow}>
                <Button variant="secondary" wide label={t("mobile.browser.live.couldnt")} onPress={couldnt} />
              </View>
              <View style={styles.grow}>
                <Button
                  variant="primary"
                  wide
                  icon="check"
                  label={t("mobile.browser.live.done")}
                  onPress={() => void finish(true)}
                />
              </View>
            </View>
            <TypeBar onInput={live.sendInput} />
          </>
        ) : !controller ? (
          <Button variant="primary" wide icon="globe" label={t("mobile.browser.live.takeOver")} onPress={takeover} />
        ) : (
          <Text variant="small" tone="muted" style={styles.watching}>
            {t("mobile.browser.live.watchOnly", { name: helper || t("mobile.chat.someone") })}
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/** The page as a picture; a tap on it clicks the page (only for the person in control). */
function FrameView({
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
function TypeBar({ onInput }: { onInput: (events: BrowserInputEvent[]) => void }) {
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

// ── The live connection ──────────────────────────────────────────────────────

interface LiveState {
  frame: BrowserFrame | null;
  unavailable: Unavailable;
  controllerUserId: string | null;
  /** The handoff the last status carried (undefined until a status arrives). */
  handoff: { controllerUserId: string | null } | null | undefined;
  sendInput: (events: BrowserInputEvent[]) => void;
}

/**
 * Watches the agent's browser on the app's realtime socket while the screen is open (as the web's
 * `useBrowserLive`): frames, who is in control, why it can't be shown. Watches again after the socket
 * reconnects; the shared connection retries on its own while the computer is "reconnecting".
 */
function useLiveConnection(agentId: string): LiveState {
  const connection = useConnection();
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [unavailable, setUnavailable] = useState<Unavailable>(null);
  const [controllerUserId, setControllerUserId] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<{ controllerUserId: string | null } | null | undefined>(undefined);
  const liveRef = useRef<ReturnType<typeof createBrowserLiveConnection> | null>(null);

  useEffect(() => {
    if (!connection) return;
    const live = createBrowserLiveConnection({
      send: (frameOut) => connection.sendBrowserFrame(frameOut),
      // Shared per socket: one watch per agent however often the screen re-renders or remounts.
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
  }, [connection, agentId]);

  const sendInput = useCallback((events: BrowserInputEvent[]) => {
    liveRef.current?.sendInput(events);
  }, []);
  return { frame, unavailable, controllerUserId, handoff, sendInput };
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 8 },
  grow: { flex: 1, minWidth: 0 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    minHeight: 28,
    borderRadius: 999,
    flexShrink: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 2 },
  medium: { fontWeight: "500" },
  semibold: { fontWeight: "600" },
  ask: { paddingHorizontal: 16, paddingBottom: 10, gap: 2 },
  page: { flex: 1, overflow: "hidden" },
  frame: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.35)" },
  url: {
    position: "absolute",
    top: 8,
    alignSelf: "center",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    maxWidth: "70%",
  },
  bottom: { paddingHorizontal: 16, paddingTop: 10, gap: 10 },
  acts: { flexDirection: "row", gap: 8 },
  watching: { textAlign: "center", paddingVertical: 8 },
  reasons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
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
