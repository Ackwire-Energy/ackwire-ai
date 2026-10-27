import {
  browserHandoffOf,
  browserTrailOf,
  desktopTrailOf,
  keys,
  type Message,
  type ScreenKind,
  type ThreadInfo,
  useApi,
  useContinuedRun,
  useReactions,
  useSteerState,
  useToggleReaction,
} from "@agenteschat/client";
import { CONTINUE_ERRORS, errorCode, errorText } from "@agenteschat/client/lib/errors";
import { issueWorkOf } from "@agenteschat/client/lib/issues";
import { brainUnavailableOf } from "@agenteschat/client/lib/machine-outages";
import { serverBody } from "@agenteschat/client/lib/message-body";
import { missionSetupOf } from "@agenteschat/client/lib/missions";
import { isTalkerReply, routineReportText } from "@agenteschat/client/lib/notices";
import { can } from "@agenteschat/client/lib/permissions";
import { isReminderMessage, reminderBody, routineReplyOf } from "@agenteschat/client/lib/routines";
import { splitCanceled } from "@agenteschat/client/lib/work";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  CHROME_MAX_SCALE,
  Count,
  Icon,
  InkOrbit,
  PixelStopped,
  PressScale,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { NoAiCard } from "../ai/NoAiCard";
import { HandoffCard } from "../browser/HandoffCard";
import { TrailCard } from "../browser/TrailCard";
import { MessageFiles } from "../files/MessageFiles";
import { DecisionCard, MissionCard, PlanCard, ReviewCard, SetupFailedCard } from "../missions/cards";
import { BrainWait } from "../outages/WaitCard";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { ApprovalInline, ConsultationCard, QuestionCard, ThreadLink } from "./cards";
import { IssueWorkCard } from "./issue-work";
import { cacheContinued } from "./live";
import {
  approvalIdOf,
  artifactsOf,
  consultationsOf,
  hidesBody,
  missionCardRef,
  missionLinkOf,
  missionPlanOf,
  questionOf,
  reactionPills,
  workStepsOf,
} from "./logic";
import { MessageText } from "./MessageText";
import { Receipts } from "./Receipts";
import { TeamChecks } from "./TeamChecks";
import { SavedTools, TurnTools } from "./ToolCalls";
import { recentTurn, stoppedOf } from "./turn";

/** A run's message asks whether a take over still holds its browser only this recently (older: events only). */
const TRAIL_RECENT_MS = 12 * 60 * 60_000;

/**
 * One message: the face and name (dropped when grouped), a pin mark when
 * pinned, what it consulted, its text, the cards it carries and the reactions. Long press opens its
 * actions (the screen's sheet). An agent's reply takes its live block's place: its tools stay one closed
 * line above the words ("Usou N ferramentas"), and a stopped one says so with "Continuar". Under my own
 * message sent while an agent works: whether it read it ("lê na próxima pausa", "leu", "parou para ler").
 */
export const MessageRow = memo(function MessageRow({
  message: m,
  grouped,
  meId,
  thread,
  onLongPress,
  onRetry,
  offline = false,
}: {
  message: Message;
  grouped: boolean;
  meId: string | null;
  /** Its thread, when it is the root of one the conversation shows as a link. */
  thread?: ThreadInfo;
  onLongPress: (m: Message) => void;
  onRetry?: (m: Message) => void;
  /** Mine and not sent for lack of internet: it waits and goes by itself when the connection is back. */
  offline?: boolean;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const isAgent = m.author.type === "agent";
  const agent = isAgent && m.author.id ? dir.agentById.get(m.author.id) : undefined;
  const accent = agent ? agentLook(agent).color : undefined;
  const color = agentLook(agent).color;
  const name = dir.nameOf(m.author) || t("mobile.chat.someone");
  const meta = m.meta;
  // What a routine found, told by its agent (as on the web): a small tag, and the report it answers on demand
  // (that report's own line folds into this message).
  const routine = routineReplyOf(m);
  const [reportOpen, setReportOpen] = useState(false);
  const qc = useQueryClient();
  const orgId = useOrgId();
  const report = routine?.noticeId
    ? routineReportText(
        [
          ...(qc.getQueryData<Message[]>(keys.messages(orgId, m.channelId)) ?? []),
          ...((m.threadId && qc.getQueryData<Message[]>(keys.thread(orgId, m.channelId, m.threadId))) || []),
        ],
        routine.noticeId,
      )
    : null;
  // A plain reminder: the agent's own message with a "Lembrete" label (the server's prefix dropped).
  const reminder = isReminderMessage(meta);
  // A short reply it gave while its task kept working (the talker): its message, "enquanto trabalha".
  const talker = isAgent && isTalkerReply(meta);
  // What the server wrote itself is said in the person's language; a stopped reply drops the server's note.
  const body = hidesBody(m) ? "" : reminderBody(splitCanceled(serverBody(t, m.body, meta), meta).body, meta);
  const consulted = isAgent && m.author.id ? consultationsOf(meta) : [];
  const steps = isAgent && m.agentRunId ? workStepsOf(meta) : null;
  const stopped = isAgent && m.agentRunId ? stoppedOf(meta) : null;
  // This reply just took its live block's place here: the same tools (and the messages it read) stay.
  const [kept] = useState(() => (isAgent && m.agentRunId ? recentTurn(m.agentRunId, Date.now()) : null));
  const approvalId = approvalIdOf(meta);
  const review = missionCardRef(meta, "missionReview");
  const decision = missionCardRef(meta, "missionDecision");
  const plan = missionPlanOf(meta);
  // Preparing the mission's copy of the project failed (ADR 0044): the card with "Tentar de novo".
  const setup = missionSetupOf(meta);
  const link = missionLinkOf(meta);
  const files = artifactsOf(meta);
  const question = isAgent ? questionOf(meta) : null;
  // The agent needs a person in its browser (ADR 0040): the request, live.
  const handoff = isAgent ? browserHandoffOf(meta) : null;
  // Where it browsed, or what it did on its desktop, after the run (as on the web): the steps' card.
  const trails =
    isAgent && m.author.id && !m.local
      ? {
          browser: browserTrailOf(meta),
          desktop: desktopTrailOf(meta),
          recent: Date.now() - Date.parse(m.createdAt) < TRAIL_RECENT_MS,
        }
      : null;
  // Calls that have their own card under the message (where it browsed, its desktop) stay out of its tools.
  const onCards: ScreenKind[] = [
    ...(trails?.browser.length ? (["browser"] as const) : []),
    ...(trails?.desktop.length ? (["desktop"] as const) : []),
  ];
  // "Esperando o MacBook Air voltar": its brain's computer is offline (the card, when it says which computer).
  const brainWait = isAgent && Boolean(brainUnavailableOf(meta)?.machineId);
  // The root of an issue's work thread (asked an agent to implement it): the issue card.
  const issueWork = issueWorkOf(meta);
  // My own message: a light bubble on the right, no face or name.
  const mine = m.author.type === "person" && Boolean(meId) && m.author.id === meId;

  const cards = (
    <>
      {issueWork ? (
        <IssueWorkCard work={issueWork} authorId={m.author.type === "person" ? (m.author.id ?? null) : null} />
      ) : null}
      {thread && !meta?.missionStart ? (
        <View style={mine ? styles.meEnd : undefined}>
          <ThreadLink thread={thread} />
        </View>
      ) : null}
      {meta?.missionStart ? <MissionCard threadId={m.id} /> : null}
      {link ? <MissionCard missionId={link.missionId} /> : null}
      {plan ? <PlanCard missionId={plan.missionId} goal={plan.goal} /> : null}
      {review ? <ReviewCard missionId={review.missionId} reviewId={review.id} /> : null}
      {decision ? <DecisionCard missionId={decision.missionId} decisionId={decision.id} /> : null}
      {setup ? (
        <SetupFailedCard
          {...(setup.missionId ? { missionId: setup.missionId } : {})}
          threadId={m.threadId}
          error={setup.error}
          {...(setup.reason === "branch_missing" ? { lostBranch: setup.branch ?? null } : {})}
        />
      ) : null}
      <View style={mine ? styles.meEnd : undefined}>
        <Reactions message={m} meId={meId} />
      </View>
      {m.local === "pending" || (m.local === "failed" && offline) ? (
        <Sending offline={offline} end={mine} />
      ) : m.local === "failed" ? (
        <Pressable onPress={() => onRetry?.(m)} accessibilityRole="button" hitSlop={8}>
          <Text variant="caption" tone="danger" style={mine ? styles.meStatus : undefined}>
            {t("mobile.chat.failed")}
          </Text>
        </Pressable>
      ) : null}
    </>
  );

  if (mine)
    return (
      <Pressable
        onLongPress={() => {
          tapHaptic();
          onLongPress(m);
        }}
        delayLongPress={380}
        accessibilityHint={t("mobile.chat.longPressHint")}
        style={({ pressed }) => [styles.me, grouped && styles.meCont, pressed && styles.mePressed]}
      >
        {m.pinned ? (
          <View style={[styles.pinLine, styles.meEnd]}>
            <PinMark />
            <Text variant="caption" tone="faint">
              {t("mobile.pins.mark")}
            </Text>
          </View>
        ) : null}
        {body ? (
          <View style={[styles.bubble, { backgroundColor: c.bubble }]}>
            <MessageText body={body} muted={m.local === "pending"} selectable={false} accent={accent} />
          </View>
        ) : null}
        {files.length > 0 ? (
          <View style={styles.meFiles}>
            <MessageFiles files={files} align="end" />
          </View>
        ) : null}
        <View style={styles.meCards}>{cards}</View>
        {m.local ? null : <SteerLine message={m} />}
      </Pressable>
    );

  return (
    <Pressable
      onLongPress={() => {
        tapHaptic();
        onLongPress(m);
      }}
      delayLongPress={380}
      accessibilityHint={t("mobile.chat.longPressHint")}
      style={({ pressed }) => [styles.msg, grouped && styles.cont, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={styles.avslot}>{grouped ? null : <Face who={m.author} size={32} live={false} />}</View>
      <View style={styles.body}>
        {grouped ? null : (
          <View style={styles.who}>
            <Text variant="footnote" tone="ink2" style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            {reminder ? <Tag icon="bell" label={t("channel.reminder")} /> : null}
            {routine ? (
              <Tag
                icon="clock"
                label={t("channel.routineTag", { name: routine.name })}
                onPress={report ? () => setReportOpen((o) => !o) : undefined}
                hint={report ? t(reportOpen ? "channel.routineReportHide" : "channel.routineReport") : undefined}
              />
            ) : null}
            {talker ? (
              <Text
                variant="caption"
                tone="faint"
                numberOfLines={1}
                style={styles.shrink}
                accessibilityHint={t("chat.notice.talkerTip")}
              >
                {t("chat.notice.talker")}
              </Text>
            ) : null}
            {!reminder && !routine && !talker && agent?.role ? (
              <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
                {agent.role}
              </Text>
            ) : null}
            <Text variant="footnote" tone="faint">
              {when.time(m.createdAt)}
            </Text>
            {m.pinned ? <PinMark /> : null}
          </View>
        )}
        {grouped && m.pinned ? (
          <View style={styles.pinLine}>
            <PinMark />
            <Text variant="caption" tone="faint">
              {t("mobile.pins.mark")}
            </Text>
          </View>
        ) : null}
        {report && reportOpen ? (
          <View style={[styles.report, { borderLeftColor: c.line }]}>
            <MessageText body={report} />
          </View>
        ) : null}
        {consulted.map((cs) => (
          <ConsultationCard key={cs.consultationId} askerId={m.author.id ?? ""} consultation={cs} />
        ))}
        {kept ? (
          <TurnTools
            items={kept.items}
            agentName={agent?.name ?? name}
            color={color}
            quoteOf={(id) => kept.quotes[id]}
            done
            settled
          />
        ) : steps && m.agentRunId ? (
          <SavedTools
            runId={m.agentRunId}
            meta={meta}
            agentName={agent?.name ?? name}
            color={color}
            skipScreens={onCards}
          />
        ) : null}
        {brainWait ? (
          <BrainWait
            message={m}
            fallback={
              body ? <MessageText body={body} muted={m.local === "pending"} selectable={false} accent={accent} /> : null
            }
          />
        ) : body ? (
          <MessageText body={body} muted={m.local === "pending"} selectable={false} accent={accent} />
        ) : null}
        {stopped && m.agentRunId ? <StoppedLine message={m} runId={m.agentRunId} stopped={stopped} /> : null}
        {isAgent && m.actions?.length ? <Receipts message={m} /> : null}
        {isAgent ? <TeamChecks message={m} /> : null}
        {isAgent ? <NoAiCard message={m} /> : null}
        {files.length > 0 ? <MessageFiles files={files} /> : null}
        {approvalId ? <ApprovalInline approvalId={approvalId} /> : null}
        {handoff ? <HandoffCard handoff={handoff} /> : null}
        {trails && m.author.id && trails.browser.length > 0 ? (
          <TrailCard
            agentId={m.author.id}
            runId={m.agentRunId ?? null}
            steps={trails.browser}
            stopped={stopped}
            recent={trails.recent}
          />
        ) : null}
        {trails && m.author.id && trails.desktop.length > 0 ? (
          <TrailCard
            agentId={m.author.id}
            runId={m.agentRunId ?? null}
            steps={trails.desktop}
            stopped={stopped}
            screen="desktop"
          />
        ) : null}
        {question ? <QuestionCard key={`${question.id}:${question.status}`} question={question} /> : null}
        {cards}
      </View>
    </Pressable>
  );
});

/** My message on its way: "Enviando" only past half a second; offline, a clock and when it will go. */
function Sending({ offline, end }: { offline: boolean; end: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 500);
    return () => clearTimeout(timer);
  }, []);
  if (!offline && !slow) return null;
  return (
    <View style={[styles.status, end && styles.statusEnd]}>
      {offline ? <Icon name="clock" size={12} color={c.faint} /> : <InkOrbit size={10} color={c.faint} />}
      <Text variant="caption" tone="faint">
        {offline ? t("mobile.chat.offlineWait") : t("mobile.chat.sending")}
      </Text>
    </View>
  );
}

/**
 * Under my message sent while an agent works: "{nome} lê na próxima pausa" (the ink
 * orbit) until it reads it, "{nome} parou para ler" when I asked it to stop and read (or it woke a wait),
 * "{nome} recebeu" (a check) once handed to its computer mid-turn, "{nome} lê depois da sua decisão no
 * card" (paused) while an approval holds it, then "{nome} leu" or "{nome} encerrou o pedido de ajuda"
 * with its small face (the shared store, `useSteerState`, as on the web).
 */
function SteerLine({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const reduced = useReducedMotion();
  const steer = useSteerState(orgId, m.channelId, m.id);
  if (!steer) return null;
  const name = dir.agentById.get(steer.agentId)?.name ?? t("channel.unknownAgent");
  return (
    <Animated.View
      key={steer.state}
      entering={reduced ? undefined : FadeIn.duration(250)}
      style={[styles.status, styles.statusEnd]}
      accessibilityLiveRegion="polite"
    >
      {steer.state === "read" || steer.state === "resolved" ? (
        <AgentFace agentId={steer.agentId} size={16} live={false} framed={false} />
      ) : steer.state === "now" ? (
        <Icon name="bolt" size={12} color={c.muted} />
      ) : steer.state === "delivered" ? (
        <Icon name="check" size={12} color={c.muted} />
      ) : steer.state === "held" ? (
        <Icon name="pause" size={12} color={c.muted} />
      ) : (
        <InkOrbit size={10} color={c.muted} />
      )}
      <Text variant="caption" tone="muted">
        {t(`mobile.chat.steer.${steer.state}`, { name })}
      </Text>
    </Animated.View>
  );
}

/**
 * A reply someone stopped: what it wrote stays, with "Parado por você · Continuar"; the
 * button picks up from where it stopped (a new run) and goes away once it did, for everyone.
 */
function StoppedLine({
  message: m,
  runId,
  stopped,
}: {
  message: Message;
  runId: string;
  stopped: { byUserId: string | null; continuedRunId: string | null };
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const meId = useMeId();
  const dir = useDirectory();
  const role = useOrg().org?.role;
  const { colors: c, shadows } = useTheme();
  const [busy, setBusy] = useState(false);
  // Continued here or on another device (`run.continued`), or already in the message's meta.
  const continued = useContinuedRun(m.id) ?? stopped.continuedRunId;
  const byMe = Boolean(meId) && stopped.byUserId === meId;
  const by = byMe
    ? t("mobile.chat.stopped.byYou")
    : stopped.byUserId
      ? t("mobile.chat.stopped.by", { name: dir.nameOf({ type: "person", id: stopped.byUserId }) })
      : t("mobile.chat.stopped.plain");
  const owner = m.author.id ? dir.agentById.get(m.author.id)?.ownerUserId : null;
  // Same people who may stop it (the server checks again).
  const may = byMe || can(role, "manage_agents") || (Boolean(meId) && owner === meId);
  const open = may && !continued && !busy;
  const onContinue = () => {
    setBusy(true);
    api.agents
      .continueRun(orgId, runId)
      .then(({ runId: newRunId }) => cacheContinued(qc, orgId, m.channelId, m.id, newRunId))
      .catch((err: unknown) => {
        setBusy(false);
        // Refused for a reason it can say (already continued, the agent busy here, not allowed): say it.
        // The event or a refetch hides the button when it has no job left.
        const code = errorCode(err);
        toast({
          title: code && CONTINUE_ERRORS.has(code) ? errorText(t, err) : t("mobile.chat.stopped.failed"),
          icon: "x",
        });
      });
  };
  return (
    <View style={styles.stopped}>
      <PixelStopped size={12} />
      <Text variant="caption" tone="muted">
        {by}
      </Text>
      {open ? (
        <>
          <Text variant="caption" tone="faint">
            ·
          </Text>
          <PressScale
            onPress={onContinue}
            accessibilityRole="button"
            style={[styles.continue, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
          >
            <View style={styles.continueIn}>
              <Icon name="play" size={12} color={c.ink} />
              <Text variant="caption" tone="ink" style={styles.medium} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                {t("mobile.chat.stopped.continue")}
              </Text>
            </View>
          </PressScale>
        </>
      ) : null}
    </View>
  );
}

/**
 * A small neutral chip next to the name ("Lembrete", "Rotina «Bom dia»"): icon, no colored dot. With
 * `onPress` it unfolds what it stands for (the report a routine's message answers).
 */
function Tag({
  icon,
  label,
  onPress,
  hint,
}: {
  icon: "bell" | "clock";
  label: string;
  onPress?: () => void;
  hint?: string;
}) {
  const c = useColors();
  const chip = (
    <View style={[styles.tag, { backgroundColor: c.sunken }]}>
      <Icon name={icon} size={11} color={c.muted} />
      <Text variant="caption" tone="muted" numberOfLines={1} style={styles.shrink}>
        {label}
      </Text>
    </View>
  );
  if (!onPress) return chip;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityHint={hint} hitSlop={6}>
      {chip}
    </Pressable>
  );
}

/** Pinned: a small neutral pin (no colored dot). */
function PinMark() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.pin} accessible accessibilityLabel={t("mobile.pins.mark")}>
      <Icon name="pin" size={12} color={c.faint} />
    </View>
  );
}

/** People's pills show a count (mine outlined); an agent that reacted shows its face. */
function Reactions({ message: m, meId }: { message: Message; meId: string | null }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const cached = useReactions(orgId, m.id, false);
  const toggle = useToggleReaction(orgId, m.id);
  const pills = reactionPills(cached.data ?? m.reactions, meId);
  if (pills.length === 0 || m.local) return null;
  return (
    <View style={styles.reacts}>
      {pills.flatMap((p) => [
        ...(p.people > 0
          ? [
              <Pressable
                key={`p:${p.reaction}`}
                onPress={() => {
                  tapHaptic();
                  toggle.mutate({ reaction: p.reaction, on: !p.mine });
                }}
                accessibilityRole="button"
                accessibilityLabel={t("mobile.chat.reactionLabel", { emoji: p.emoji, count: p.people })}
                accessibilityState={{ selected: p.mine }}
                style={[
                  styles.react,
                  { backgroundColor: c.sunken },
                  p.mine && { borderWidth: 1.5, borderColor: c.ink2 },
                ]}
              >
                <Text maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.emoji}>
                  {p.emoji}
                </Text>
                <Count value={p.people} size={14} />
              </Pressable>,
            ]
          : []),
        ...p.agentIds.map((agentId) => (
          <View
            key={`a:${p.reaction}:${agentId}`}
            accessible
            accessibilityLabel={t("mobile.chat.agentReacted", { emoji: p.emoji })}
            style={[styles.react, { backgroundColor: c.sunken }]}
          >
            <Text maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.emoji}>
              {p.emoji}
            </Text>
            <AgentFace agentId={agentId} size={16} live={false} />
          </View>
        )),
      ])}
    </View>
  );
}

const styles = StyleSheet.create({
  // Readable turns: more room between turns, a quieter name and time.
  msg: { flexDirection: "row", gap: 11, paddingLeft: 14, paddingRight: 16, paddingVertical: 10, marginTop: 4 },
  cont: { paddingTop: 0, marginTop: 0 },
  avslot: { width: 34, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  who: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 3 },
  name: { fontWeight: "600", fontSize: 14, lineHeight: 19 },
  me: { paddingLeft: 64, paddingRight: 16, paddingVertical: 10, marginTop: 4, alignItems: "flex-end" },
  meCont: { paddingTop: 2, marginTop: 0 },
  mePressed: { opacity: 0.7 },
  meEnd: { alignSelf: "flex-end" },
  bubble: {
    maxWidth: "100%",
    paddingVertical: 10,
    paddingHorizontal: 15,
    borderTopLeftRadius: 21,
    borderTopRightRadius: 21,
    borderBottomLeftRadius: 21,
    borderBottomRightRadius: 6,
  },
  meFiles: { alignSelf: "stretch" },
  meCards: { alignSelf: "stretch" },
  meStatus: { marginTop: 4, textAlign: "right" },
  status: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4, minHeight: 18 },
  statusEnd: { alignSelf: "flex-end" },
  stopped: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6 },
  continue: {
    minHeight: 26,
    borderTopLeftRadius: 9,
    borderTopRightRadius: 9,
    borderBottomRightRadius: 9,
    borderBottomLeftRadius: 3,
  },
  continueIn: { flexGrow: 1, flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: 8, paddingRight: 10 },
  medium: { fontWeight: "600" },
  shrink: { flexShrink: 1 },
  pin: { alignSelf: "center" },
  // The routine report a message answers, unfolded under its name (like the notice line's text).
  report: { marginTop: 2, marginBottom: 4, paddingLeft: 10, borderLeftWidth: 2 },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "center",
    flexShrink: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  pinLine: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 },
  reacts: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  react: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  emoji: { fontSize: 15 },
});
