import { type Message, type ThreadInfo, useReactions, useToggleReaction } from "@agenteschat/client";
import { issueWorkOf } from "@agenteschat/client/lib/issues";
import { brainUnavailableOf } from "@agenteschat/client/lib/machine-outages";
import { serverBody } from "@agenteschat/client/lib/message-body";
import { isReminderMessage, reminderBody, routineOfMessage, viaRoutineOf } from "@agenteschat/client/lib/routines";
import { splitCanceled } from "@agenteschat/client/lib/work";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { CHROME_MAX_SCALE, Count, Icon, Text } from "@/ui";
import { MessageFiles } from "../files/MessageFiles";
import { DecisionCard, MissionCard, PlanCard, ReviewCard } from "../missions/cards";
import { BrainWait } from "../outages/WaitCard";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { ApprovalInline, ConsultationCard, QuestionCard, StepsCard, ThreadLink } from "./cards";
import { IssueWorkCard } from "./issue-work";
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

/**
 * One message: the face and name (dropped when grouped), a pin mark when
 * pinned, what it consulted, its text, the cards it carries and the reactions. Long press opens its
 * actions (the screen's sheet).
 */
export const MessageRow = memo(function MessageRow({
  message: m,
  grouped,
  meId,
  thread,
  onLongPress,
  onRetry,
}: {
  message: Message;
  grouped: boolean;
  meId: string | null;
  /** Its thread, when it is the root of one the conversation shows as a link. */
  thread?: ThreadInfo;
  onLongPress: (m: Message) => void;
  onRetry?: (m: Message) => void;
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
  const approvalId = approvalIdOf(meta);
  const review = missionCardRef(meta, "missionReview");
  const decision = missionCardRef(meta, "missionDecision");
  const plan = missionPlanOf(meta);
  const link = missionLinkOf(meta);
  const files = artifactsOf(meta);
  const question = isAgent ? questionOf(meta) : null;
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
      <View style={mine ? styles.meEnd : undefined}>
        <Reactions message={m} meId={meId} />
      </View>
      {m.local === "pending" ? (
        <Text variant="caption" tone="faint" style={mine ? styles.meStatus : undefined}>
          {t("mobile.chat.sending")}
        </Text>
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
        {brainWait ? (
          <BrainWait
            message={m}
            fallback={body ? <MessageText body={body} muted={m.local === "pending"} selectable={false} /> : null}
          />
        ) : body ? (
          <MessageText body={body} muted={m.local === "pending"} selectable={false} />
        ) : null}
        {steps && m.agentRunId ? <StepsCard runId={m.agentRunId} steps={steps} /> : null}
        {isAgent && m.actions?.length ? <Receipts message={m} /> : null}
        {files.length > 0 ? <MessageFiles files={files} /> : null}
        {approvalId ? <ApprovalInline approvalId={approvalId} /> : null}
        {question ? <QuestionCard key={`${question.id}:${question.status}`} question={question} /> : null}
        {cards}
      </View>
    </Pressable>
  );
});

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
