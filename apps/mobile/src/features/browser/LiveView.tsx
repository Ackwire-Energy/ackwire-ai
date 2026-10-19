import {
  createBrowserLiveConnection,
  realtimeUrl,
  type SocketLike,
  useAgentBrowserHandoff,
  useBrowserHandoff,
  useBrowserHandoffActions,
} from "@agenteschat/client";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Image, type LayoutChangeEvent, Pressable, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { API_URL } from "@/config";
import { lastCookie, readCookie } from "@/lib/auth";
import { createSocketFactory } from "@/lib/socket";
import { Button, IconButton, Text, ToastHost, useTheme, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import {
  type Box,
  clickAt,
  FAILED_REASONS,
  hostOf,
  isOpen,
  keyPress,
  LIVE_KEYS,
  type LiveInput,
  type LiveKey,
  liveBackoff,
  pagePoint,
  textInput,
} from "./logic";

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

interface Frame {
  data: string;
  width: number;
  height: number;
  url: string;
}

type Unavailable = "reconnecting" | "offline" | "no_computer" | "unavailable" | "ended" | "forbidden" | null;

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
  const byId = useBrowserHandoff(orgId, handoffId ?? "");
  const byAgent = useAgentBrowserHandoff(orgId, agentId);
  const [statusHandoff, setStatusHandoff] = useState<{ controllerUserId: string | null } | null>(null);
  const handoff = (handoffId ? byId.data : byAgent.data) ?? null;
  const name = dir.agentById.get(agentId)?.name ?? "";
  const g = genderOf(name);
  const live = useLiveConnection(orgId, agentId);
  const controller = statusHandoff?.controllerUserId ?? live.controllerUserId ?? handoff?.controllerUserId ?? null;
  const mine = Boolean(meId) && controller === meId;
  const open = handoff ? isOpen(handoff.status) : false;

  // Opening a request someone asked for takes the control (first one wins; the other sees who).
  const claimed = useRef(false);
  useEffect(() => {
    if (!handoff || claimed.current || handoff.status !== "pending") return;
    claimed.current = true;
    void Promise.resolve(actions.takeControl(handoff.id)).catch(() => {});
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
        {live.frame?.url ? (
          <View style={[styles.url, { backgroundColor: c.raised }]}>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {hostOf(live.frame.url)}
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
  frame: Frame;
  enabled: boolean;
  onInput: (events: LiveInput[]) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<Box>({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) =>
    setView({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  return (
    <Pressable
      style={styles.frame}
      onLayout={onLayout}
      disabled={!enabled}
      accessibilityLabel={t("mobile.browser.live.page")}
      onPress={(e) => {
        const p = pagePoint({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }, view, {
          width: frame.width,
          height: frame.height,
        });
        if (!p) return;
        tapHaptic();
        onInput(clickAt(p));
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
function TypeBar({ onInput }: { onInput: (events: LiveInput[]) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const [text, setText] = useState("");
  const [secret, setSecret] = useState(false);
  const send = () => {
    if (!text) return;
    onInput(textInput(text));
    setText("");
  };
  const key = (k: LiveKey) => {
    tapHaptic();
    onInput(keyPress(k));
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

// ── The socket ───────────────────────────────────────────────────────────────

interface LiveState {
  frame: Frame | null;
  unavailable: Unavailable;
  controllerUserId: string | null;
  /** The handoff the last status carried (undefined until a status arrives). */
  handoff: { controllerUserId: string | null } | null | undefined;
  sendInput: (events: LiveInput[]) => void;
}

/**
 * Its own socket to `/api/ws` while the screen is open (frames stay off the conversation's socket and stop
 * when the screen closes). Reconnects with backoff, and watches again when the server says "reconnecting".
 */
function useLiveConnection(orgId: string, agentId: string): LiveState {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [unavailable, setUnavailable] = useState<Unavailable>(null);
  const [controllerUserId, setControllerUserId] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<{ controllerUserId: string | null } | null | undefined>(undefined);
  const sendRef = useRef<(events: LiveInput[]) => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let socket: SocketLike | null = null;
    let conn: ReturnType<typeof createBrowserLiveConnection> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const createSocket = createSocketFactory(lastCookie);

    const again = () => {
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, liveBackoff(attempt++));
    };
    const drop = () => {
      conn?.close();
      conn = null;
      const s = socket;
      socket = null;
      if (s) {
        s.onclose = null;
        s.close();
      }
    };
    const connect = () => {
      if (stopped) return;
      void readCookie().then(() => {
        if (stopped) return;
        const s = createSocket(realtimeUrl(API_URL, orgId));
        socket = s;
        s.onopen = () => {
          if (stopped || socket !== s) return;
          conn = createBrowserLiveConnection({
            send: (frameOut: unknown) => {
              if (socket === s) s.send(typeof frameOut === "string" ? frameOut : JSON.stringify(frameOut));
            },
            agentId,
            onFrame: (f) => {
              attempt = 0;
              setUnavailable(null);
              setFrame({
                data: f.data,
                width: f.metadata.deviceWidth,
                height: f.metadata.deviceHeight,
                url: f.metadata.url ?? "",
              });
            },
            onStatus: (st) => {
              setControllerUserId(st.controllerUserId ?? null);
              setHandoff(st.handoff ? { controllerUserId: st.handoff.controllerUserId ?? null } : null);
            },
            onUnavailable: (u) => {
              setUnavailable(u.reason);
              if (u.reason === "reconnecting") {
                drop();
                again();
              }
            },
            onEnded: () => setUnavailable("ended"),
            onError: (e) => {
              if (e.code === "forbidden" || e.code === "not_found") setUnavailable("forbidden");
            },
          });
        };
        s.onmessage = (ev) => {
          if (socket !== s || typeof ev.data !== "string") return;
          try {
            conn?.handleMessage(JSON.parse(ev.data));
          } catch {}
        };
        s.onclose = () => {
          if (socket !== s) return;
          drop();
          setUnavailable((u) => (u === "ended" || u === "forbidden" ? u : "reconnecting"));
          again();
        };
        s.onerror = () => {};
      });
    };
    sendRef.current = (events) => conn?.sendInput(events);
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      drop();
      sendRef.current = () => {};
    };
  }, [orgId, agentId]);

  return {
    frame,
    unavailable,
    controllerUserId,
    handoff,
    sendInput: (events) => sendRef.current(events),
  };
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
