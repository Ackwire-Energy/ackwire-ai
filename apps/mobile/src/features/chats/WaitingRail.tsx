import type { AppNotification, Approval, Mission } from "@agenteschat/client";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Chip, Count, Fuse, Icon, type IconName, Text } from "@/ui";
import { notificationHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow } from "../shared/hooks";
import { agentLook, fuseRemaining, minutesLeft } from "../shared/logic";
import { useSurface } from "../shared/parts";
import { missionWaitingItems } from "./logic";

/** A card's width and the gap between cards (the rail snaps card by card). */
const CARD = 282;
const GAP = 10;

export interface WaitingInput {
  approvals: Approval[];
  missions: Mission[];
  questions: AppNotification[];
  /** A channel's name by id (the "em #canal" of a card). */
  channelName: (id: string | null | undefined) => string | null;
}

/**
 * "Esperando você" at the top of Conversas (MobileConversas.html): one card per request (with its fuse),
 * per mission with something to review or decide, and per agent question, in a rail that snaps card by
 * card. Tapping opens the request, the mission, or the conversation where the question was asked.
 */
export function WaitingRail({ approvals, missions, questions, channelName, total }: WaitingInput & { total: number }) {
  const { t } = useTranslation();
  return (
    <View style={styles.wait} accessibilityLabel={t("mobile.home.waiting")}>
      <View style={styles.head}>
        <Text variant="callout" style={styles.bold} accessibilityRole="header">
          {t("mobile.home.waiting")}
        </Text>
        <Count value={total} size={16} />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={CARD + GAP}
        decelerationRate="fast"
        contentContainerStyle={styles.rail}
      >
        {approvals.map((a) => (
          <ApprovalWait key={a.id} approval={a} where={channelName(a.channelId)} />
        ))}
        {missions.map((m) => (
          <MissionWait key={m.id} mission={m} where={channelName(m.channelId)} />
        ))}
        {questions.map((n) => (
          <QuestionWait key={n.id} item={n} where={channelName(n.source.channelId)} />
        ))}
      </ScrollView>
    </View>
  );
}

/** The card's frame: who asks and where, the kind as a chip, the title (two lines), the footer. */
function WaitCard({
  agentId,
  where,
  chip,
  title,
  footer,
  label,
  onPress,
}: {
  agentId: string | null;
  where: string | null;
  chip: { icon: IconName; label: string };
  title: string;
  footer: ReactNode;
  label: string;
  onPress: (() => void) | null;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const surface = useSurface();
  const name = agentId ? (dir.agentById.get(agentId)?.name ?? "") : "";
  return (
    <Pressable
      onPress={onPress ?? undefined}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={[name, chip.label, title, label].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}
    >
      <View style={styles.hd}>
        {agentId ? <AgentFace agentId={agentId} size={20} live={false} /> : null}
        {name ? (
          <Text variant="footnote" tone="ink" style={styles.bold} numberOfLines={1}>
            {name}
          </Text>
        ) : null}
        {where ? (
          <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
            {t("mobile.chats.waitIn", { where })}
          </Text>
        ) : null}
        <View style={styles.grow} />
        <Chip icon={chip.icon} label={chip.label} />
      </View>
      <Text variant="callout" style={[styles.bold, styles.title]} numberOfLines={2}>
        {title}
      </Text>
      <View style={styles.ft}>{footer}</View>
    </Pressable>
  );
}

/** "→ Responder na conversa": the footer of a card that only opens something. */
function GoFooter({ text }: { text: string }) {
  const c = useColors();
  return (
    <>
      <Icon name="right" size={15} color={c.faint} />
      <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.shrink}>
        {text}
      </Text>
    </>
  );
}

function ApprovalWait({ approval: a, where }: { approval: Approval; where: string | null }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const now = useNow();
  const left = t("mobile.approval.expiresIn", { count: minutesLeft(a.expiresAt, now) });
  return (
    <WaitCard
      agentId={a.agentId}
      where={where ? `#${where}` : null}
      chip={{ icon: "shield", label: t("mobile.chats.waitApprove") }}
      title={a.title}
      label={left}
      onPress={() => router.push(`/approval/${a.id}`)}
      footer={
        <>
          <View style={styles.grow}>
            <Fuse
              color={agentLook(dir.agentById.get(a.agentId)).color}
              remaining={fuseRemaining(a.createdAt, a.expiresAt, now)}
            />
          </View>
          <Text variant="footnote" tone="faint">
            {left}
          </Text>
        </>
      }
    />
  );
}

function MissionWait({ mission: m, where }: { mission: Mission; where: string | null }) {
  const { t } = useTranslation();
  const text = t("mobile.mission.waitingYou", { count: missionWaitingItems(m) });
  return (
    <WaitCard
      agentId={m.agentId}
      where={where ? `#${where}` : null}
      chip={{ icon: "target", label: t("mobile.mission.kind") }}
      title={m.title}
      label={text}
      onPress={() => router.push(`/mission/${m.id}`)}
      footer={<GoFooter text={text} />}
    />
  );
}

function QuestionWait({ item: n, where }: { item: AppNotification; where: string | null }) {
  const { t } = useTranslation();
  const actor = n.actors[0];
  const href = notificationHref(n);
  const text = t("mobile.chats.answerInChat");
  return (
    <WaitCard
      agentId={actor?.type === "agent" ? actor.id : null}
      where={where ? `#${where}` : null}
      chip={{ icon: "help", label: t("mobile.chats.waitQuestion") }}
      title={n.latest.text ?? n.latest.title ?? ""}
      label={text}
      onPress={href ? () => router.push(href) : null}
      footer={<GoFooter text={text} />}
    />
  );
}

const styles = StyleSheet.create({
  wait: { marginTop: 4, marginBottom: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingBottom: 8 },
  rail: { gap: GAP, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8 },
  card: { width: CARD, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 22, gap: 6 },
  pressed: { transform: [{ scale: 0.98 }] },
  hd: { flexDirection: "row", alignItems: "center", gap: 7 },
  bold: { fontWeight: "600" },
  shrink: { flexShrink: 1 },
  grow: { flex: 1, minWidth: 0 },
  title: { minHeight: 42, lineHeight: 21 },
  ft: { flexDirection: "row", alignItems: "center", gap: 8 },
});
