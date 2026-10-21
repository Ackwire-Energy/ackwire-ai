import {
  browserHandoffOf,
  type Message,
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
import { can } from "@agenteschat/client/lib/permissions";
import { isReminderMessage, reminderBody, routineOfMessage, viaRoutineOf } from "@agenteschat/client/lib/routines";
import { splitCanceled } from "@agenteschat/client/lib/work";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useState } from "react";
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
import { HandoffCard } from "../browser/HandoffCard";
import { MessageFiles } from "../files/MessageFiles";
import { DecisionCard, MissionCard, PlanCard, ReviewCard, SetupFailedCard } from "../missions/cards";
import { BrainWait } from "../outages/WaitCard";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { ApprovalInline, ConsultationCard, QuestionCard, StepsCard, ThreadLink } from "./cards";
import { IssueWorkCard } from "./issue-work";
import { FoldingWork } from "./LiveRows";
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
  routineAgents,
  workStepsOf,
} from "./logic";
import { MessageText } from "./MessageText";
import { Receipts } from "./Receipts";
import { recentTurn, stoppedOf } from "./turn";

/**
 * One message: the face and name (dropped when grouped), a pin mark when
 * pinned, what it consulted, its text, the cards it carries and the reactions. Long press opens its
 * actions (the screen's sheet). An agent's reply takes its live block's place: the work folds into
 * "N passos" above the words, and a stopped one says so with "Continuar". Under my own message sent
 * while an agent works: whether it read it ("lê na próxima pausa", "leu", "parou para ler").
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
  const name = dir.nameOf(m.author) || t("mobile.chat.someone");
  const meta = m.meta;
  // Posted by a routine on its creator's behalf (as on the web): shown as the routine, never as if the person
  // typed it; its text is the instructions it gives the agent, one line ("Chamou @Atlas…") and the rest on demand.
  const routine = routineOfMessage(meta);
  const [routineOpen, setRoutineOpen] = useState(false);
  const called = useMemo(() => (routine ? routineAgents(m.body, dir.agents) : []), [routine, m.body, dir.agents]);
  // An agent's answer to a routine: the routine's call is hidden, so a small tag says so.
  const viaRoutine = isAgent ? viaRoutineOf(meta) : null;
  // A plain reminder: the agent's own message with a "Lembrete" label (the server's prefix dropped).
  const reminder = isReminderMessage(meta);
  // What the server wrote itself is said in the person's language; a stopped reply drops the server's note.
  const body =
    hidesBody(m) || (routine && !routineOpen)
      ? ""
      : reminderBody(splitCanceled(serverBody(t, m.body, meta), meta).body, meta);
  const consulted = isAgent && m.author.id ? consultationsOf(meta) : [];
  const steps = isAgent && m.agentRunId ? workStepsOf(meta) : null;
  const stopped = isAgent && m.agentRunId ? stoppedOf(meta) : null;
  // This reply just took its live block's place here: the block's work folds away above it.
  const [folds] = useState(() => Boolean(isAgent && m.agentRunId && recentTurn(m.agentRunId, Date.now())));
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
  // "Esperando o MacBook Air voltar": its brain's computer is offline (the card, when it says which computer).
  const brainWait = isAgent && Boolean(brainUnavailableOf(meta)?.machineId);
  // The root of an issue's work thread (asked an agent to implement it): the issue card.
  const issueWork = issueWorkOf(meta);
  // My own message: a light bubble on the right, no face or name (MobileIntencional.html, `.me`).
  const mine = !routine && m.author.type === "person" && Boolean(meId) && m.author.id === meId;

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
            <MessageText body={body} muted={m.local === "pending"} selectable={false} />
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
      <View style={styles.avslot}>
        {grouped ? null : routine ? (
          <View
            style={[styles.routineMark, { backgroundColor: c.sunken }]}
            accessible
            accessibilityLabel={t("channel.routineAuthor", { name: routine.name })}
          >
            <Icon name="clock" size={17} color={c.ink2} />
          </View>
        ) : (
          <Face who={m.author} size={32} live={false} />
        )}
      </View>
      <View style={styles.body}>
        {grouped ? null : routine ? (
          <View style={styles.who}>
            <Text variant="footnote" tone="ink2" style={[styles.name, styles.shrink]} numberOfLines={1}>
              {t("channel.routineAuthor", { name: routine.name })}
            </Text>
            <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
              {t("channel.routineBy", { name })}
            </Text>
            <Text variant="footnote" tone="faint">
              {when.time(m.createdAt)}
            </Text>
            {m.pinned ? <PinMark /> : null}
          </View>
        ) : (
          <View style={styles.who}>
            <Text variant="footnote" tone="ink2" style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            {reminder ? <Tag icon="bell" label={t("channel.reminder")} /> : null}
            {viaRoutine ? <Tag icon="clock" label={t("channel.viaRoutine", { name: viaRoutine.name })} /> : null}
            {!reminder && !viaRoutine && agent?.role ? (
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
        {routine ? (
          <Text variant="small" tone="muted">
            {called.length
              ? t("channel.routineCalled", { names: called.map((a) => `@${a.name}`).join(", ") })
              : t("channel.routineRan")}{" "}
            <Text
              variant="small"
              tone="ink"
              style={styles.link}
              onPress={() => setRoutineOpen((o) => !o)}
              accessibilityRole="button"
              accessibilityState={{ expanded: routineOpen }}
              suppressHighlighting
            >
              {routineOpen ? t("channel.routineHide") : t("channel.routineShow")}
            </Text>
          </Text>
        ) : null}
        {consulted.map((cs) => (
          <ConsultationCard key={cs.consultationId} askerId={m.author.id ?? ""} consultation={cs} />
        ))}
        {folds && m.agentRunId && m.author.id ? <FoldingWork runId={m.agentRunId} agentId={m.author.id} /> : null}
        {steps && m.agentRunId ? <StepsCard runId={m.agentRunId} steps={steps} /> : null}
        {brainWait ? (
          <BrainWait
            message={m}
            fallback={body ? <MessageText body={body} muted={m.local === "pending"} selectable={false} /> : null}
          />
        ) : body ? (
          <MessageText body={body} muted={m.local === "pending"} selectable={false} />
        ) : null}
        {stopped && m.agentRunId ? <StoppedLine message={m} runId={m.agentRunId} stopped={stopped} /> : null}
        {isAgent && m.actions?.length ? <Receipts message={m} /> : null}
        {files.length > 0 ? <MessageFiles files={files} /> : null}
        {approvalId ? <ApprovalInline approvalId={approvalId} /> : null}
        {handoff ? <HandoffCard handoff={handoff} /> : null}
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
 * Under my message sent while an agent works (Mensagens.html, C): "{nome} lê na próxima pausa" (the ink
 * orbit) until it reads it, "{nome} parou para ler" when I asked it to stop and read, then "{nome} leu"
 * with its small face.
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
      {steer.state === "read" ? (
        <AgentFace agentId={steer.agentId} size={16} live={false} framed={false} />
      ) : steer.state === "now" ? (
        <Icon name="bolt" size={12} color={c.muted} />
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
 * A reply someone stopped (Mensagens.html): what it wrote stays, with "Parado por você · Continuar"; the
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

/** A small neutral chip next to the name ("Lembrete", "Rotina · Bom dia"): icon, no colored dot. */
function Tag({ icon, label }: { icon: "bell" | "clock"; label: string }) {
  const c = useColors();
  return (
    <View style={[styles.tag, { backgroundColor: c.sunken }]}>
      <Icon name={icon} size={11} color={c.muted} />
      <Text variant="caption" tone="muted" numberOfLines={1} style={styles.shrink}>
        {label}
      </Text>
    </View>
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
  // Readable turns (MobileIntencional.html): more room between turns, a quieter name and time.
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
  routineMark: { width: 32, height: 32, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  link: { fontWeight: "600" },
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
