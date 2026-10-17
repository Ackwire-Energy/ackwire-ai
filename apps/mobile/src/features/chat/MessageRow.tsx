import { type Message, type ThreadInfo, useReactions, useToggleReaction } from "@agenteschat/client";
import { serverBody } from "@agenteschat/client/lib/message-body";
import { splitCanceled } from "@agenteschat/client/lib/work";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Count, fonts, Text } from "@/ui";
import { DecisionCard, MissionCard, PlanCard, ReviewCard } from "../missions/cards";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { ApprovalInline, ConsultationCard, FileCard, StepsCard, ThreadLink } from "./cards";
import {
  approvalIdOf,
  artifactsOf,
  consultationsOf,
  hidesBody,
  missionCardRef,
  missionLinkOf,
  missionPlanOf,
  reactionPills,
  workStepsOf,
} from "./logic";
import { MessageText } from "./MessageText";

/**
 * One message: the face and name (dropped when grouped), what it consulted,
 * its text, the cards it carries and the reactions. Long press opens its
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
  // What the server wrote itself is said in the person's language; a stopped reply drops the server's note.
  const body = hidesBody(m) ? "" : splitCanceled(serverBody(t, m.body, meta), meta).body;
  const consulted = isAgent && m.author.id ? consultationsOf(meta) : [];
  const steps = isAgent && m.agentRunId ? workStepsOf(meta) : null;
  const approvalId = approvalIdOf(meta);
  const review = missionCardRef(meta, "missionReview");
  const decision = missionCardRef(meta, "missionDecision");
  const plan = missionPlanOf(meta);
  const link = missionLinkOf(meta);
  const files = artifactsOf(meta);

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
            <Text variant="small" tone="ink" style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            {agent?.role ? (
              <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
                {agent.role}
              </Text>
            ) : null}
            <Text variant="caption" tone="faint">
              {when.time(m.createdAt)}
            </Text>
          </View>
        )}
        {consulted.map((cs) => (
          <ConsultationCard key={cs.consultationId} askerId={m.author.id ?? ""} consultation={cs} />
        ))}
        {body ? <MessageText body={body} muted={m.local === "pending"} /> : null}
        {steps && m.agentRunId ? <StepsCard runId={m.agentRunId} steps={steps} /> : null}
        {files.map((f) => (
          <FileCard
            key={f.id}
            id={f.id}
            {...(f.version !== undefined ? { version: f.version } : {})}
            title={f.title}
            deleted={f.deleted}
          />
        ))}
        {approvalId ? <ApprovalInline approvalId={approvalId} /> : null}
        {thread && !meta?.missionStart ? <ThreadLink thread={thread} /> : null}
        {meta?.missionStart ? <MissionCard threadId={m.id} /> : null}
        {link ? <MissionCard missionId={link.missionId} /> : null}
        {plan ? <PlanCard missionId={plan.missionId} goal={plan.goal} /> : null}
        {review ? <ReviewCard missionId={review.missionId} reviewId={review.id} /> : null}
        {decision ? <DecisionCard missionId={decision.missionId} decisionId={decision.id} /> : null}
        <Reactions message={m} meId={meId} />
        {m.local === "pending" ? (
          <Text variant="caption" tone="faint">
            {t("mobile.chat.sending")}
          </Text>
        ) : m.local === "failed" ? (
          <Pressable onPress={() => onRetry?.(m)} accessibilityRole="button" hitSlop={8}>
            <Text variant="caption" tone="danger">
              {t("mobile.chat.failed")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
});

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
                <Text style={styles.emoji}>{p.emoji}</Text>
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
            <Text style={styles.emoji}>{p.emoji}</Text>
            <AgentFace agentId={agentId} size={16} live={false} />
          </View>
        )),
      ])}
    </View>
  );
}

const styles = StyleSheet.create({
  msg: { flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  cont: { paddingTop: 0 },
  avslot: { width: 34, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  who: { flexDirection: "row", alignItems: "baseline", gap: 7 },
  name: { fontFamily: fonts.bold },
  shrink: { flexShrink: 1 },
  reacts: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  react: { height: 30, paddingHorizontal: 10, borderRadius: 999, flexDirection: "row", alignItems: "center", gap: 6 },
  emoji: { fontSize: 15 },
});
