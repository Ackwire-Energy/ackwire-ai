import {
  browserHandoffOf,
  browserTrailOf,
  desktopTrailOf,
  keys,
  type Message,
  type MessageReceipt,
  type RunConsultation,
  type ScreenKind,
  type ThreadInfo,
  useApi,
  useConsultations,
  useContinuedRun,
  useReactions,
  useToggleReaction,
  useWaiting,
} from "@agenteschat/client";
import { CONTINUE_ERRORS, errorCode, errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { issueWorkOf } from "@agenteschat/client/lib/issues";
import { brainUnavailableOf } from "@agenteschat/client/lib/machine-outages";
import { serverBody } from "@agenteschat/client/lib/message-body";
import { missionSetupOf } from "@agenteschat/client/lib/missions";
import { isTalkerReply, routineReportText } from "@agenteschat/client/lib/notices";
import { can } from "@agenteschat/client/lib/permissions";
import { isReminderMessage, reminderBody, routineReplyOf } from "@agenteschat/client/lib/routines";
import { splitCanceled } from "@agenteschat/client/lib/work";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { CHROME_MAX_SCALE, Count, Icon, InkOrbit, PixelStopped, PressScale, Text, useTheme, useToast } from "@/ui";
import { ProposalCard } from "../agents/ProposalCard";
import { NoAiCard } from "../ai/NoAiCard";
import { StretchCard } from "../ai/StretchCard";
import { HandoffCard } from "../browser/HandoffCard";
import { TrailCard } from "../browser/TrailCard";
import { MessageFiles } from "../files/MessageFiles";
import { consultationHref, routineHref } from "../links/logic";
import { DecisionCard, MissionCard, PlanCard, ReviewCard, SetupFailedCard } from "../missions/cards";
import { BrainWait } from "../outages/WaitCard";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { ReceiptMark } from "./AgentReceipts";
import { ConsultGroup } from "./ConsultGroup";
import { ApprovalInline, ConsultationCard, QuestionCard, ThreadLink } from "./cards";
import { IssueWorkCard } from "./issue-work";
import { cacheContinued } from "./live";
import {
  approvalIdOf,
  artifactsOf,
  consultationsOf,
  hidesBody,
  mayStopRun,
  missionCardRef,
  missionLinkOf,
  missionPlanOf,
  questionOf,
  reactionPills,
  workStepsOf,
} from "./logic";
import { MemoryMarks } from "./MemoryMark";
import { MessageText } from "./MessageText";
import { Receipts } from "./Receipts";
import { TeamChecks } from "./TeamChecks";
import { SavedTools, TurnTools } from "./ToolCalls";
import { recentTurn, stepLimitOf, stoppedOf, turnOpener } from "./turn";

/** A run's message asks whether a take over still holds its browser only this recently (older: events only). */
const TRAIL_RECENT_MS = 12 * 60 * 60_000;
/** The room beside my bubble for its receipt's mark: my row's 64px left padding past the screen's 16px edge. */
const MARK_ROOM = 48;

/**
 * One message: the face and name (dropped when grouped), a pin mark when
 * pinned, what it consulted, its text, the cards it carries and the reactions. Long press opens its
 * actions (the screen's sheet). An agent's reply takes its live block's place: its tools stay one closed
 * line under its words and what it changed ("Usou N ferramentas"), the same place live, kept and saved, and a
 * stopped one says so with "Continuar". A person's message's
 * receipt is a mark in room the row already has (`ReceiptMark`), so it never changes the row's height: beside my
 * bubble, whether an agent read it ("lê na próxima pausa", "leu") or who read it in a DM; at the end of someone
 * else's name line, the agents' receipt of their latest message.
 */
export const MessageRow = memo(function MessageRow({
  message: m,
  grouped,
  meId,
  thread,
  onLongPress,
  onRetry,
  receipt,
  seenBy,
  readOnly = false,
}: {
  message: Message;
  grouped: boolean;
  meId: string | null;
  /** Its thread, when it is the root of one the conversation shows as a link. */
  thread?: ThreadInfo;
  /** Absent where it is read only. */
  onLongPress?: (m: Message) => void;
  onRetry?: (m: Message) => void;
  /** The agents' receipt its mark shows: the latest person's message's, on it or on its turn's first row. */
  receipt?: MessageReceipt;
  /** A DM between people: who read this message, my latest. */
  seenBy?: string;
  /** Shown where the person can't act on it (two agents' conversation): no long press, reactions or block. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  // Mine and not sent for lack of a connection: it waits and goes by itself when the connection is back.
  const offline = useWaiting(m.local === "failed" ? m.clientId : null);
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
  // A question to another agent (in their DM) carries the asking run: its work shows on that run's reply.
  const ownWork = isAgent && Boolean(m.agentRunId) && !meta?.consultation;
  const steps = ownWork ? workStepsOf(meta) : null;
  // Posted by a run answering another agent's question from here (its approval, question, secret): whom it helps.
  const consultations = useConsultations(orgId, m.channelId, isAgent && Boolean(m.agentRunId) && !readOnly);
  const helping =
    isAgent && m.agentRunId && !readOnly
      ? consultations.data?.find((x) => x.consultedRunId === m.agentRunId)
      : undefined;
  const press = readOnly
    ? undefined
    : () => {
        tapHaptic();
        onLongPress?.(m);
      };
  const stopped = isAgent && m.agentRunId ? stoppedOf(meta) : null;
  // The reply of a run that reached its step limit: the same line, with Continuar.
  const atLimit = isAgent && m.agentRunId && !stopped ? stepLimitOf(meta) : null;
  // This reply just took its live block's place here: the same tools (and the messages it read) stay.
  const [kept] = useState(() => (ownWork && m.agentRunId ? recentTurn(m.agentRunId, Date.now()) : null));
  // The line its block opened with stays above the tools, where it was, instead of moving into them (`turnOpener`).
  const opened =
    kept && m.agentRunId ? turnOpener({ runId: m.agentRunId, status: "running", text: "" }, kept.items) : null;
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

  // The cards it carries: above an agent's tools, which come last.
  const cards = (
    <>
      {issueWork ? (
        <IssueWorkCard work={issueWork} authorId={m.author.type === "person" ? (m.author.id ?? null) : null} />
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
    </>
  );
  // Under everything: the thread it started, its reactions and whether it went out.
  const foot = (
    <>
      {thread && !meta?.missionStart ? (
        <View style={mine ? styles.meEnd : undefined}>
          <ThreadLink thread={thread} />
        </View>
      ) : null}
      {readOnly ? null : (
        <View style={mine ? styles.meEnd : undefined}>
          <Reactions message={m} meId={meId} />
        </View>
      )}
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

  if (mine) {
    // The bubble, or the files of a message with no words, leads; the receipt's mark stands beside it.
    const lead = body ? (
      <View style={[styles.bubble, styles.lead, { backgroundColor: c.bubble }]}>
        <MessageText body={body} muted={m.local === "pending"} selectable={false} accent={accent} />
      </View>
    ) : files.length > 0 ? (
      <View style={styles.grow}>
        <MessageFiles files={files} align="end" />
      </View>
    ) : null;
    return (
      <Pressable
        onLongPress={press}
        delayLongPress={380}
        accessibilityHint={press ? t("mobile.chat.longPressHint") : undefined}
        style={({ pressed }) => [styles.me, grouped && styles.meCont, pressed && press && styles.mePressed]}
      >
        {m.pinned ? (
          <View style={[styles.pinLine, styles.meEnd]}>
            <PinMark />
            <Text variant="caption" tone="faint">
              {t("mobile.pins.mark")}
            </Text>
          </View>
        ) : null}
        {lead ? (
          <View style={styles.meLine}>
            <View style={styles.meMark}>
              {m.local ? null : <ReceiptMark message={m} mine receipt={receipt} seenBy={seenBy} />}
            </View>
            {lead}
          </View>
        ) : null}
        {body && files.length > 0 ? (
          <View style={styles.meFiles}>
            <MessageFiles files={files} align="end" />
          </View>
        ) : null}
        <View style={styles.meCards}>
          {cards}
          {foot}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onLongPress={press}
      delayLongPress={380}
      accessibilityHint={press ? t("mobile.chat.longPressHint") : undefined}
      style={({ pressed }) => [styles.msg, grouped && styles.cont, pressed && press && { backgroundColor: c.sunken }]}
    >
      <View style={styles.avslot}>{grouped ? null : <Face who={m.author} size={32} live={false} />}</View>
      <View style={styles.body}>
        {grouped ? null : (
          <View style={[styles.who, m.author.type === "person" && styles.whoRoom]}>
            <Text variant="footnote" tone="ink2" style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            {reminder ? <Tag icon="bell" label={t("channel.reminder")} /> : null}
            {routine ? (
              // The tag opens the routine (Rotinas, as on the web); "Ver relatório" beside it unfolds the report.
              <Tag
                icon="clock"
                label={t("channel.routineTag", { name: routine.name })}
                onPress={() => router.push(routineHref(routine.id))}
                hint={t("channel.routineTagTip")}
              />
            ) : null}
            {routine && report ? (
              <Pressable
                onPress={() => setReportOpen((o) => !o)}
                accessibilityRole="button"
                accessibilityState={{ expanded: reportOpen }}
                hitSlop={6}
                style={styles.shrink}
              >
                <Text variant="caption" tone="muted" numberOfLines={1} style={styles.medium}>
                  {reportOpen ? t("channel.routineReportHide") : t("channel.routineReport")}
                </Text>
              </Pressable>
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
            {helping ? <HelpingTag consultation={helping} channelId={m.channelId} /> : null}
            {!reminder && !routine && !talker && !helping && agent?.role ? (
              <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
                {agent.role}
              </Text>
            ) : null}
            <Text variant="footnote" tone="faint">
              {when.time(m.createdAt)}
            </Text>
            {m.pinned ? <PinMark /> : null}
            {receipt && !m.local ? (
              <View style={styles.whoMark}>
                <ReceiptMark message={m} mine={false} receipt={receipt} />
              </View>
            ) : null}
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
        {opened?.said ? <MessageText body={opened.said} selectable={false} accent={accent} /> : null}
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
        {(stopped || atLimit) && m.agentRunId ? (
          <StoppedLine
            message={m}
            runId={m.agentRunId}
            stopped={stopped ?? { byUserId: null, continuedRunId: atLimit?.continuedRunId ?? null }}
            limit={Boolean(atLimit)}
          />
        ) : null}
        {isAgent && m.actions?.length ? <Receipts message={m} /> : null}
        {isAgent ? <TeamChecks message={m} /> : null}
        {isAgent ? <NoAiCard message={m} /> : null}
        {isAgent ? <StretchCard message={m} /> : null}
        {isAgent ? <ProposalCard message={m} /> : null}
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
        {/* Its tools last, after its words, what it changed and its cards: the same place live, kept and saved. */}
        {isAgent && m.agentRunId && !m.local && !readOnly && consulted.length === 0 ? (
          <ConsultGroup message={m} color={color} />
        ) : null}
        {kept ? (
          <TurnTools
            items={opened?.lines ?? kept.items}
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
        {foot}
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
 * A reply someone stopped: what it wrote stays, with "Parado por você · Continuar" ("No limite de passos ·
 * Continuar" under the reply of a run that reached its step limit); the button picks up from where it stopped
 * (a new run) and goes away once it did, for everyone.
 */
function StoppedLine({
  message: m,
  runId,
  stopped,
  limit = false,
}: {
  message: Message;
  runId: string;
  stopped: { byUserId: string | null; continuedRunId: string | null };
  limit?: boolean;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const meId = useMeId();
  const dir = useDirectory();
  const org = useOrg().org;
  const { colors: c, shadows } = useTheme();
  const [busy, setBusy] = useState(false);
  // Continued here or on another device (`run.continued`), or already in the message's meta.
  const continued = useContinuedRun(m.id) ?? stopped.continuedRunId;
  const byMe = Boolean(meId) && stopped.byUserId === meId;
  const by = limit
    ? t("mobile.chat.stopped.limit")
    : byMe
      ? t("mobile.chat.stopped.byYou")
      : stopped.byUserId
        ? t("mobile.chat.stopped.by", { name: dir.nameOf({ type: "person", id: stopped.byUserId }) })
        : t("mobile.chat.stopped.plain");
  const owner = m.author.id ? dir.agentById.get(m.author.id)?.ownerUserId : null;
  const loaded = [
    ...(qc.getQueryData<Message[]>(keys.messages(orgId, m.channelId)) ?? []),
    ...((m.threadId && qc.getQueryData<Message[]>(keys.thread(orgId, m.channelId, m.threadId))) || []),
  ];
  // Same people who may stop it (the server checks again): an admin, the agent's owner, or who asked.
  const may =
    byMe ||
    mayStopRun(
      { agentId: m.author.id ?? "", threadId: m.threadId ?? m.id, triggerMessageId: null },
      { meId, manageAgents: can(org, "manage_agents"), agentOwnerId: owner, messages: loaded },
    );
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
 * `onPress` it opens what it stands for (the routine a message answers).
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
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={hint}
      hitSlop={6}
      style={styles.tagPress}
    >
      {chip}
    </Pressable>
  );
}

/** On a card this agent posted while answering another agent's question: "ajudando o Theo · Ver conversa". */
function HelpingTag({ consultation: c, channelId }: { consultation: RunConsultation; channelId: string }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const from = agentGrammar(t, dir.agentById.get(c.agentId)?.name ?? t("mobile.chat.someone"));
  return (
    <>
      <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
        {t("chat.consultPanel.helping", { name: from.name, article: from.article })}
      </Text>
      <Pressable
        onPress={() => router.push(consultationHref(c.id, channelId))}
        accessibilityRole="button"
        hitSlop={6}
        style={styles.shrink}
      >
        <Text variant="caption" tone="muted" numberOfLines={1} style={styles.medium}>
          {t("chat.consultPanel.see")}
        </Text>
      </Pressable>
    </>
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

/** People's pills show a count (mine outlined); an agent that reacted shows its face; then the memory marks. */
function Reactions({ message: m, meId }: { message: Message; meId: string | null }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const cached = useReactions(orgId, m.id, false);
  const toggle = useToggleReaction(orgId, m.id);
  const pills = reactionPills(cached.data ?? m.reactions, meId);
  // What an agent saved to memory from this message comes last in the row (the web's memory mark).
  const remembered = (m.memories?.length ?? 0) > 0;
  if ((pills.length === 0 && !remembered) || m.local) return null;
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
      {remembered ? <MemoryMarks message={m} divided={pills.length > 0} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Readable turns: more room between turns, a quieter name and time.
  msg: { flexDirection: "row", gap: 11, paddingLeft: 14, paddingRight: 16, paddingVertical: 10, marginTop: 4 },
  cont: { paddingTop: 0, marginTop: 0 },
  avslot: { width: 34, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  // Wraps on a narrow phone: a routine's tag and "Ver relatório" go to the next line instead of off the edge.
  who: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 3, marginBottom: 3 },
  // A person's name line keeps room at its end for the receipt's mark, with or without one, so a mark that comes
  // never wraps the line.
  whoRoom: { paddingRight: 40 },
  whoMark: { position: "absolute", top: 0, right: 0, height: 19, justifyContent: "center" },
  name: { fontWeight: "600", fontSize: 14, lineHeight: 19, flexShrink: 1 },
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
  // My row keeps 64px free on the left, 48 of them past the screen's 16px edge: the receipt's mark stands there, on
  // the bubble's last line (10px under the text, 24px lines), so it never adds a line.
  meLine: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "flex-end",
    marginLeft: -MARK_ROOM,
  },
  meMark: { width: MARK_ROOM, alignItems: "flex-end", paddingRight: 6, paddingBottom: 14 },
  lead: { flexShrink: 1 },
  grow: { flex: 1 },
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
  // The chip's own shrink only works if what holds it can shrink too (a long routine name ends in "…").
  tagPress: { flexShrink: 1, maxWidth: "100%", alignSelf: "center" },
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
