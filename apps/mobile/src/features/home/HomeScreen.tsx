import {
  type AppNotification,
  keys,
  type Mission,
  useMe,
  useMissionDecisions,
  useMissionList,
  useMissionReviews,
  useNotifications,
  useWorkingRuns,
} from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { router, useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar, Button, Card, fonts, IconButton, PersonAvatar, PixelOrbit, Row, Section, Sky, Text } from "@/ui";
import { crewOf } from "../agents/logic";
import { workTitle, workWhere } from "../agents/work";
import { ApprovalAsk } from "../approvals/ApprovalAsk";
import { ConversationRowView } from "../chats/ConversationRowView";
import { chatHref, notificationHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook, firstName, greetingKey } from "../shared/logic";
import { useConversations, useWaitingApprovals, useWorkingNow } from "../shared/queries";

/**
 * Início: the greeting over the light sky and the crew (working ones bigger),
 * what waits on you (requests with their fuse, mission reviews and
 * decisions, agents' questions), who is working now, and the latest
 * conversations.
 */
export function HomeScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const me = useMe();
  const dir = useDirectory();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const approvals = useWaitingApprovals();
  const waitingMissions = useMissionList(orgId, { status: "waiting_you" });
  const questions = useNotifications(orgId, "waiting");
  const work = useWorkingNow();
  const runs = useWorkingRuns(orgId);
  const conversations = useConversations();
  const [refreshing, setRefreshing] = useState(false);
  const qc = useQueryClient();
  const focused = useIsFocused();
  // Runs start and finish in conversations this screen doesn't follow live: look again while it shows.
  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: keys.working(orgId) }), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [focused, qc, orgId]);

  const missions = (waitingMissions.data?.missions ?? []).filter((m) => m.canAct);
  const missionItems = missions.reduce((n, m) => n + m.pending.reviews + m.pending.decisions, 0);
  const asks = (questions.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (n) => n.kind === "agent_question" && !n.doneAt,
  );
  const waiting = approvals.length + missionItems + asks.length;
  const busy = new Set(work.map((w) => w.agentId));
  const crew = crewOf(dir.agents, busy, 6);
  const name = firstName(me.data?.user.name ?? "");

  const refresh = async () => {
    setRefreshing(true);
    await Promise.allSettled([waitingMissions.refetch(), questions.refetch(), conversations.refetch(), runs.refetch()]);
    setRefreshing(false);
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 110 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <View style={[styles.hello, { paddingTop: insets.top + 8 }]}>
          <Sky color="sky" depth={0.7} style={StyleSheet.absoluteFill} />
          <View style={styles.top}>
            <Pressable
              onPress={() => router.push("/me")}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.me.title")}
              hitSlop={6}
            >
              <PersonAvatar name={me.data?.user.name ?? "?"} size={34} />
            </Pressable>
            <View style={styles.grow} />
            <IconButton icon="search" label={t("mobile.find.title")} plate onPress={() => router.push("/search")} />
          </View>
          <Text variant="display">
            {name ? t(`mobile.home.greeting.${greetingKey()}`, { name }) : t(`mobile.home.hello.${greetingKey()}`)}
          </Text>
          <Text variant="body" tone="muted" style={styles.sub}>
            {[
              waiting > 0 ? t("mobile.home.waitingLine", { count: waiting }) : t("mobile.home.nothingWaiting"),
              t("mobile.home.workingLine", { count: busy.size }),
            ].join(" ")}
          </Text>
          {crew.length > 0 ? (
            <View style={styles.crew}>
              {crew.map(({ agent, busy: on }) => (
                <Pressable
                  key={agent.id}
                  onPress={() => router.push(`/agent/${agent.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={on ? t("mobile.agents.workingLabel", { name: agent.name }) : agent.name}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <AgentAvatar agent={agentLook(agent)} size={on ? 46 : 38} mode={on ? "run" : "idle"} />
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        {waiting > 0 ? (
          <Section title={t("mobile.home.waiting")} count={waiting}>
            <Card>
              {approvals.map((a, i) => (
                <ApprovalAsk key={a.id} approval={a} divider={i > 0} />
              ))}
              {missions.map((m, i) => (
                <MissionAsks key={m.id} mission={m} divider={approvals.length > 0 || i > 0} />
              ))}
              {asks.map((n, i) => (
                <QuestionAsk key={n.id} item={n} divider={approvals.length + missions.length > 0 || i > 0} />
              ))}
            </Card>
          </Section>
        ) : null}

        {work.length > 0 ? (
          <Section title={t("mobile.home.workingNow")} count={busy.size}>
            <Card>
              {work.slice(0, 6).map((w, i) => {
                const agent = dir.agentById.get(w.agentId);
                const name = agent?.name ?? "";
                return (
                  <Row
                    key={w.key}
                    leading={
                      <View>
                        {/* Only the first few move (a long list stays light). */}
                        <AgentFace agentId={w.agentId} size={34} mode="run" live={i < LIVE_ROWS} />
                        <View style={[styles.orb, { backgroundColor: c.raised }]}>
                          <PixelOrbit color={agentLook(agent).color} size={12} />
                        </View>
                      </View>
                    }
                    title={workTitle(t, w)}
                    subtitle={
                      w.plan
                        ? t("mobile.home.missionProgress", { name, done: w.plan.done, total: w.plan.total })
                        : w.what
                          ? [name, workWhere(t, w)].filter(Boolean).join(" · ")
                          : name
                    }
                    chevron
                    onPress={() =>
                      w.missionId
                        ? router.push(`/mission/${w.missionId}`)
                        : router.push(chatHref(w.channelId, w.threadId))
                    }
                  />
                );
              })}
            </Card>
          </Section>
        ) : null}

        {conversations.rows.length > 0 ? (
          <Section
            title={t("mobile.home.conversations")}
            action={{ label: t("mobile.home.seeAll"), onPress: () => router.navigate("/chats") }}
          >
            <Card>
              {conversations.rows.slice(0, 3).map((r, i) => (
                <ConversationRowView key={r.key} row={r} divider={i > 0} />
              ))}
            </Card>
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** Rows of "Trabalhando agora" whose agent moves. */
const LIVE_ROWS = 3;
/** How often "Trabalhando agora" looks again while Início shows. */
const WORKING_POLL_MS = 20_000;

/** A mission's review and decisions waiting on you, as blocks of the card. */
function MissionAsks({ mission: m, divider }: { mission: Mission; divider: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const reviews = useMissionReviews(orgId, m.id);
  const decisions = useMissionDecisions(orgId, m.id);
  const name = dir.agentById.get(m.agentId)?.name ?? "";
  const items = [
    ...(reviews.data ?? [])
      .filter((r) => r.status === "pending")
      .map((r) => ({ key: `r:${r.id}`, title: r.title, review: true })),
    ...(decisions.data ?? [])
      .filter((d) => d.status === "pending" || d.status === "provisional")
      .map((d) => ({ key: `d:${d.id}`, title: d.question, review: false })),
  ];
  return (
    <>
      {items.map((it, i) => (
        <View
          key={it.key}
          style={[
            styles.ask,
            (divider || i > 0) && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
          ]}
        >
          <View style={styles.hd}>
            <AgentFace agentId={m.agentId} size={22} live={false} />
            <Text variant="small" tone="ink" style={styles.bold}>
              {name}
            </Text>
            <Text variant="small" tone="muted" numberOfLines={1} style={styles.shrink}>
              {t("mobile.home.inMission", { title: m.title })}
            </Text>
          </View>
          <Text variant="title" style={styles.askTitle}>
            {it.title}
          </Text>
          <View style={styles.acts}>
            {it.review ? (
              <Button
                variant="primary"
                size="sm"
                label={t("mobile.home.see")}
                onPress={() => router.push(`/mission/${m.id}`)}
              />
            ) : (
              <Button
                variant="secondary"
                size="sm"
                label={t("mobile.home.answer")}
                onPress={() => router.push(`/mission/${m.id}`)}
              />
            )}
          </View>
        </View>
      ))}
    </>
  );
}

/** An agent's question to you: "Responder" opens where it was asked. */
function QuestionAsk({ item: n, divider }: { item: AppNotification; divider: boolean }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const actor = n.actors[0];
  const name = actor ? dir.nameOf({ type: actor.type === "agent" ? "agent" : "person", id: actor.id }) : "";
  const href = notificationHref(n);
  return (
    <View style={[styles.ask, divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line }]}>
      <View style={styles.hd}>
        {actor?.type === "agent" ? <AgentFace agentId={actor.id} size={22} live={false} /> : null}
        <Text variant="small" tone="ink" style={styles.bold}>
          {name}
        </Text>
        <Text variant="small" tone="muted">
          {t("mobile.home.asksYou")}
        </Text>
      </View>
      <Text variant="title" style={styles.askTitle} numberOfLines={4}>
        {n.latest.text ?? n.latest.title ?? ""}
      </Text>
      {href ? (
        <View style={styles.acts}>
          <Button variant="secondary" size="sm" label={t("mobile.home.answer")} onPress={() => router.push(href)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  hello: { paddingHorizontal: 20, paddingBottom: 18, overflow: "hidden" },
  top: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 18 },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  sub: { marginTop: 6 },
  crew: { flexDirection: "row", alignItems: "flex-end", gap: 14, marginTop: 20, minHeight: 58 },
  pressed: { transform: [{ scale: 0.92 }] },
  orb: { position: "absolute", right: -4, bottom: -4, padding: 2, borderRadius: 3 },
  ask: { paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12 },
  hd: { flexDirection: "row", alignItems: "center", gap: 8 },
  bold: { fontFamily: fonts.semibold },
  askTitle: { marginTop: 7, marginBottom: 10 },
  acts: { flexDirection: "row", gap: 8 },
});
