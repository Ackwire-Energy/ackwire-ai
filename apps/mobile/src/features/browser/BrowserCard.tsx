import {
  type BrowserHandoff,
  type BrowserStep,
  browserSteps,
  handoffFuse,
  handoffMinutesLeft,
  isOpenHandoff,
  type LiveRun,
  rememberHeldPlace,
  useAgentBrowserHandoff,
  useBrowserHandoffActions,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { Sky } from "@/sky/Sky";
import { Button, Fuse, Icon, PixelOrbit, Text, useToast } from "@/ui";
import { useColors, useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { successHaptic, tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { FAILED_REASONS, NOTE_MAX, pageNoteOf, siteOf } from "./logic";
import { FrameView, TypeBar, useLiveConnection } from "./parts";

/** The log's last lines under the page (the prototype shows three). */
const LOG_LINES = 3;

/** One line of the log, in the person's words ("Abriu loja.exemplo", "Preencheu um campo"), as on the web. */
export function stepText(t: TFunction, s: Pick<BrowserStep, "tool" | "detail">): string {
  const tool = s.tool.replace(/^mcp__agentes__/, "");
  if (tool === "browser_open")
    return s.detail
      ? t("browser.watch.step.browser_open", { detail: s.detail })
      : t("browser.watch.step.browser_open_plain");
  const key = `browser.watch.step.${tool}`;
  const text = t(key);
  return text === key ? t("browser.watch.step.other") : text;
}

/**
 * The agent's browser as its card in the conversation (NavegadorNoChat.html, A "No card" with the
 * "Céu" header): a thin sky in the agent's color on top, the site's letter and host, and what the agent
 * does now. Open, the same card shows the page live with the last steps; Assumir (or Abrir on a request)
 * turns it into control right there: the request as the title, Pronto in the header, the app's own
 * field ("Digite aqui", Senha for saved passwords) and Não consegui; a take over ends with Devolver.
 * Pronto and Devolver take an optional note. Nothing leaves the conversation. The page streams only
 * while the card is open, the agent works or I'm in control; while someone else is, it stays theirs.
 */
export function BrowserCard({
  agentId,
  run,
  busy = false,
  handoff: given,
  open: openProp,
  onToggle,
  claim = false,
  computer,
  style,
}: {
  agentId: string;
  /** The agent's run in its browser (what it does now, the log). */
  run?: LiveRun | null;
  /** At work with no run to show here (its profile): closed, the card still shows its small live picture. */
  busy?: boolean;
  /** A request for help this card answers (the request's own message). */
  handoff?: BrowserHandoff | null;
  /** Controlled open state (the conversation opens the card from the working line); else its own. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** Opened from a push or the inbox: open and take the control once. */
  claim?: boolean;
  /** The computer the browser runs on (its profile): what an idle card says. */
  computer?: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const raised = useSurface("e2");
  const now = useNow(15_000);
  const actions = useBrowserHandoffActions(orgId);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (onToggle) onToggle(next);
    else setOwnOpen(next);
  };

  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const g = genderOf(name);
  const color = agentLook(agent).color;
  // A take over has no message of its own: the agent's open request, while this card is open.
  const ofAgent = useAgentBrowserHandoff(orgId, agentId, open && !given);
  const handoff = given ?? (ofAgent.data && isOpenHandoff(ofAgent.data) ? ofAgent.data : null);
  // Open, or closed while the agent works in it (its small live picture); a finished one keeps the last frame.
  // The person in control keeps watching even closed: their watching is what keeps their control.
  const holding = Boolean(meId) && handoff?.status === "active" && handoff.controllerUserId === meId;
  const working = Boolean(run) || busy;
  const watching = open || working || holding;
  const live = useLiveConnection(agentId, watching);
  const controller = live.handoff?.controllerUserId ?? live.controllerUserId ?? handoff?.controllerUserId ?? null;
  const mine = Boolean(meId) && controller === meId;
  const waiting = handoff?.status === "pending";
  const steps = browserSteps(run?.work);
  const host = siteOf(live.frame?.metadata.url, steps);
  const doing = steps.at(-1);
  const helper = controller && !mine ? dir.nameOf({ type: "person", id: controller }) : "";
  const closed = live.unavailable === "closed";
  // Assumir and Parar need a live page to drive (the phone has no address field to open one).
  const ready = watching && Boolean(live.frame) && !live.unavailable;
  const note = pageNoteOf(live.unavailable, live.hidden, mine);
  const doneLabel = handoff?.kind === "takeover" ? t("mobile.browser.live.handBack") : t("mobile.browser.live.done");

  // A push or the inbox opened this request: the card opens and takes the control (first one wins).
  const claimed = useRef(false);
  useEffect(() => {
    if (!claim || claimed.current || !handoff || handoff.status !== "pending") return;
    claimed.current = true;
    setOwnOpen(true);
    onToggle?.(true);
    actions.takeControl(handoff.id).catch(() => {});
  }, [claim, handoff, actions, onToggle]);

  const failedToast = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const answer = async () => {
    tapHaptic();
    setOpen(true);
    if (handoff?.status !== "pending") return;
    try {
      await actions.takeControl(handoff.id);
    } catch {
      failedToast();
    }
  };
  const takeover = async () => {
    tapHaptic();
    setOpen(true);
    try {
      // From a run's card: bound to that run, so the card stays in this conversation while the run waits.
      const h = await actions.takeover(agentId, run?.runId);
      if (h.kind === "takeover" && h.runId && run) {
        rememberHeldPlace({ runId: h.runId, agentId, channelId: run.channelId, threadId: run.threadId });
      }
    } catch (err) {
      if ((err as { status?: number }).status === 409) toast({ title: t("browser.card.busy"), icon: "x" });
      else failedToast();
    }
  };
  const finish = async (ok: boolean, said?: string) => {
    if (!handoff) return;
    const text = said?.slice(0, NOTE_MAX) || undefined;
    try {
      if (ok) await actions.done(handoff.id, text);
      else await actions.failed(handoff.id, text);
      successHaptic();
    } catch {
      failedToast();
    }
  };
  // Pronto / Devolver: what the person wants the agent to know, which it reads as their own words.
  const handBack = () => {
    tapHaptic();
    sheet.open(
      <PromptForm
        title={t("mobile.browser.done.title")}
        intro={t(`mobile.browser.done.intro${g}`, { name })}
        placeholder={t("mobile.browser.done.placeholder")}
        submitLabel={doneLabel}
        icon="check"
        allowEmpty
        onSubmit={async (text) => {
          sheet.close();
          await finish(true, text);
        }}
      />,
    );
  };
  const stop = () => {
    tapHaptic();
    Alert.alert(t(`mobile.browser.card.stopAsk${g}`, { name }), undefined, [
      { text: t("mobile.common.cancel"), style: "cancel" },
      {
        text: t("browser.watch.stop"),
        style: "destructive",
        onPress: () => void actions.stop(agentId).catch(failedToast),
      },
    ]);
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

  // ── The header: what the card says it is ──
  // A take over asks nothing: its title is the site, as while watching.
  const asked = (mine || waiting) && handoff?.instructions ? handoff.instructions : "";
  // Nothing going on (its profile, the agent idle): the agent's browser and where it runs, not "in the browser".
  const idle = !working && !handoff && !host;
  const title = asked || host || (idle ? t("browser.inCard.group", agentGrammar(t, name)) : t("browser.watch.title"));
  const minutes = waiting ? handoffMinutesLeft(handoff, now) : null;
  const subtitle = mine
    ? host
      ? t("mobile.browser.card.inControlAt", { host })
      : t("mobile.browser.live.inControl")
    : waiting
      ? minutes !== null
        ? t("mobile.browser.card.needsFor", { name, count: minutes })
        : t("mobile.browser.card.needs", { name })
      : helper
        ? t("mobile.browser.live.helping", { name: helper })
        : closed
          ? t(`mobile.browser.live.unavailable.closed${g}`, { name })
          : doing
            ? t("mobile.browser.card.doing", { name, doing: stepText(t, doing) })
            : idle && computer
              ? t("browser.now.ready", { computer })
              : t(`mobile.browser.card.where${g}`, { name });

  return (
    <View style={[styles.card, raised, style]}>
      <Sky color={color} surface="raised" depth={0.95} fade={0} style={styles.sky} />
      <Pressable
        onPress={() => {
          tapHaptic();
          setOpen(!open);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}. ${subtitle}`}
        style={styles.head}
      >
        {!open ? (
          // Closed: the page's small live picture (NavegadorCardScroll.html, 4).
          <View style={[styles.thumb, { backgroundColor: c.sunken, borderColor: c.line }]}>
            {live.frame ? (
              <Image
                source={{ uri: `data:image/jpeg;base64,${live.frame.data}` }}
                style={StyleSheet.absoluteFill}
                resizeMode="cover"
                fadeDuration={0}
              />
            ) : (
              <Icon name={live.hidden ? "eyeoff" : "globe"} size={18} color={c.faint} />
            )}
          </View>
        ) : null}
        <View style={styles.grow}>
          <Text variant="footnote" tone="ink" numberOfLines={asked ? 2 : 1} style={styles.semibold}>
            {title}
          </Text>
          <View style={styles.subRow}>
            {working && !mine && !waiting && !helper && !closed ? <PixelOrbit color={color} size={10} /> : null}
            <Text variant="caption" tone="muted" numberOfLines={1} style={styles.shrink}>
              {subtitle}
            </Text>
          </View>
          {!open && !mine && !waiting ? (
            <Text variant="caption" tone="faint" numberOfLines={1} style={styles.hint}>
              {t("mobile.browser.card.expandHint")}
            </Text>
          ) : null}
        </View>
        {mine && handoff ? (
          <Button variant="secondary" size="sm" icon="check" label={doneLabel} onPress={handBack} />
        ) : waiting ? (
          <Button variant="primary" size="sm" label={t("mobile.browser.card.open")} onPress={answer} />
        ) : (
          <View style={styles.acts}>
            {!controller && ready ? (
              <>
                <Button variant="secondary" size="sm" label={t("mobile.browser.live.takeOver")} onPress={takeover} />
                <Pressable
                  onPress={stop}
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile.browser.card.stop")}
                  hitSlop={8}
                  style={styles.icon}
                >
                  <Icon name="stop" size={16} color={c.muted} />
                </Pressable>
              </>
            ) : null}
            <View style={open ? styles.flip : undefined}>
              <Icon name="chev" size={14} color={c.faint} />
            </View>
          </View>
        )}
      </Pressable>

      {open ? (
        <>
          <View style={[styles.page, { backgroundColor: c.sunken }]}>
            {live.frame ? <FrameView frame={live.frame} enabled={mine} onInput={live.sendInput} /> : null}
            {!live.frame || live.unavailable ? (
              <View style={[styles.center, live.frame ? styles.overlay : null]}>
                {note.spin ? (
                  <ActivityIndicator color={c.muted} />
                ) : note.say === "hidden" ? (
                  <Icon name="eyeoff" size={18} color={c.muted} />
                ) : null}
                <Text variant="small" tone="ink" style={[styles.semibold, styles.centerText]}>
                  {note.say === "starting"
                    ? t(`mobile.browser.card.starting${g}`, { name })
                    : note.say === "hidden"
                      ? t("mobile.browser.live.hidden", { name: helper })
                      : t(`mobile.browser.live.unavailable.${note.say}${g}`, { name })}
                </Text>
                {note.help ? (
                  <Text variant="caption" tone="muted" style={styles.centerText}>
                    {t(`mobile.browser.live.${note.help}${g}`, { name })}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
          {mine ? (
            <View style={styles.control}>
              <TypeBar onInput={live.sendInput} />
              {/* A take over asked for nothing: it only hands back. */}
              {handoff?.kind === "ask" ? (
                <Pressable onPress={couldnt} accessibilityRole="button" hitSlop={6} style={styles.couldnt}>
                  <Text variant="small" tone="muted" style={styles.medium}>
                    {t("mobile.browser.live.couldnt")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : helper ? (
            live.hidden ? null : (
              <Text variant="small" tone="muted" style={styles.note}>
                {t("mobile.browser.live.watchOnly", { name: helper })}
              </Text>
            )
          ) : steps.length > 0 ? (
            <View style={styles.log}>
              {steps.slice(-LOG_LINES).map((s, i, shown) => (
                <View
                  key={s.id}
                  style={[styles.step, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
                >
                  <Text
                    variant="caption"
                    tone={i === shown.length - 1 ? "ink" : "muted"}
                    numberOfLines={1}
                    style={[styles.grow, i === shown.length - 1 && styles.semibold]}
                  >
                    {stepText(t, s)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
      {waiting && handoff?.expiresAt ? (
        <Fuse color={color} remaining={handoffFuse(handoff, now)} style={styles.fuse} />
      ) : null}
    </View>
  );
}

/**
 * An agent's run in its browser as a row of the conversation. While the agent waits on a request for
 * help, that request's own card (on its message) is the browser: this one steps aside.
 */
export function BrowserRunCard({
  run,
  open,
  onToggle,
}: {
  run: LiveRun;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const orgId = useOrgId();
  const ofAgent = useAgentBrowserHandoff(orgId, run.agentId);
  const asked = ofAgent.data && isOpenHandoff(ofAgent.data) && ofAgent.data.kind === "ask";
  if (asked) return null;
  return <BrowserCard agentId={run.agentId} run={run} open={open} onToggle={onToggle} />;
}

const styles = StyleSheet.create({
  card: { marginTop: 12, borderRadius: 18, overflow: "hidden" },
  sky: { height: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  tile: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  subRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 },
  semibold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  acts: { flexDirection: "row", alignItems: "center", gap: 4 },
  icon: { width: 30, height: 30, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  thumb: {
    width: 96,
    height: 60,
    borderRadius: 9,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  hint: { marginTop: 2 },
  flip: { transform: [{ rotate: "180deg" }] },
  page: { aspectRatio: 16 / 10, marginHorizontal: 8, borderRadius: 12, overflow: "hidden" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 16 },
  centerText: { textAlign: "center" },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.35)" },
  control: { padding: 10, gap: 8 },
  couldnt: { alignSelf: "center", paddingVertical: 4 },
  note: { paddingHorizontal: 12, paddingVertical: 10 },
  log: { paddingHorizontal: 12, paddingVertical: 6 },
  step: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
  reasons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  fuse: { marginTop: 0 },
});
