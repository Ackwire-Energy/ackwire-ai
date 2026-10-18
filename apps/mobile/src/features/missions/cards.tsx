import {
  type Mission,
  type MissionDecision,
  type MissionReview,
  useApi,
  useMission,
  useMissionAct,
  useMissionControl,
  useMissionDecisions,
  useMissionReviews,
  useThreadMission,
} from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, Count, Icon, PixelOrbit, PlanTrack, Text, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { successHaptic, tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { missionTrack, planProgress, recommendedOption, waitingCount } from "./logic";

/**
 * The mission's cards (ADR 0029), shared by the conversation, the pinned
 * card, Início and the mission screen: the card with the plan strip, a
 * review ("Pronto para você ver"), a decision (options, Recomendado) and the
 * plan proposal (Começar / Mudar algo).
 */

// ── The mission card ─────────────────────────────────────────────────────────

/** By mission id or by its thread (the root of a `missionStart`). */
export function MissionCard({
  missionId,
  threadId,
  pinned = false,
}: {
  missionId?: string;
  threadId?: string;
  pinned?: boolean;
}) {
  const orgId = useOrgId();
  const byId = useMission(orgId, missionId);
  const byThread = useThreadMission(orgId, missionId ? null : threadId);
  const m = byId.data ?? byThread.data ?? null;
  if (!m) return null;
  return <MissionCardView mission={m} pinned={pinned} />;
}

export function MissionCardView({ mission: m, pinned = false }: { mission: Mission; pinned?: boolean }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const surface = useSurface();
  const agent = dir.agentById.get(m.agentId);
  const color = agentLook(agent).color;
  const { done, total } = planProgress(m);
  const waiting = waitingCount(m);
  const working = m.status === "active" && (m.runningTasks > 0 || (m.plan.doing ?? 0) > 0);
  return (
    <Pressable
      onPress={() => router.push(`/mission/${m.id}`)}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.mission.cardLabel", { title: m.title, done, total })}
      style={({ pressed }) => [styles.mcard, surface, pressed && styles.pressed]}
    >
      <View style={styles.row}>
        <Icon name="target" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {t("mobile.mission.kind")}
        </Text>
        <View style={styles.grow} />
        {working ? <PixelOrbit color={color} size={11} /> : null}
        <Text variant="caption" tone="muted">
          {working ? t("mobile.mission.working", { name: agent?.name ?? "" }) : t(`mobile.mission.status.${m.status}`)}
        </Text>
      </View>
      <Text variant="body" style={[styles.bold, pinned ? styles.titlePinned : styles.title]} numberOfLines={2}>
        {m.title}
      </Text>
      <PlanTrack color={color} items={missionTrack(m)} />
      <View style={[styles.row, styles.ft]}>
        <Count value={done} size={13} />
        <Text variant="caption" tone="faint">
          {t("mobile.mission.ofTotal", { total })}
        </Text>
        {waiting > 0 ? (
          <Text variant="caption" tone="ink" style={styles.bold}>
            {" · "}
            {t("mobile.mission.waitingYou", { count: waiting })}
          </Text>
        ) : null}
        <View style={styles.grow} />
        <Icon name="right" size={16} color={c.faint} />
      </View>
    </Pressable>
  );
}

// ── Review ───────────────────────────────────────────────────────────────────

export function ReviewCard({ missionId, reviewId }: { missionId: string; reviewId: string }) {
  const orgId = useOrgId();
  const reviews = useMissionReviews(orgId, missionId);
  const mission = useMission(orgId, missionId);
  const review = reviews.data?.find((r) => r.id === reviewId);
  if (!review) return null;
  return <ReviewCardView review={review} mission={mission.data ?? null} />;
}

export function ReviewCardView({ review: r, mission }: { review: MissionReview; mission: Mission | null }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const sheet = useSheet();
  const agentId = mission?.agentId ?? null;
  const name = agentId ? (dir.agentById.get(agentId)?.name ?? "") : "";
  const g = genderOf(name);
  const act = useMissionAct(orgId, r.missionId, (input: { outcome: "approve" | "changes"; note?: string }) =>
    api.missions.review(orgId, r.missionId, r.id, input.outcome, input.note),
  );
  if (r.status !== "pending") {
    return (
      <View style={[styles.done, surface]}>
        <Icon
          name={r.status === "approved" ? "check" : "reply"}
          size={16}
          color={r.status === "approved" ? c.ok : c.muted}
        />
        <Text variant="small" tone="muted" style={styles.grow}>
          {r.status === "approved"
            ? t("mobile.mission.review.approved", { title: r.title })
            : t("mobile.mission.review.changes", { title: r.title })}
        </Text>
      </View>
    );
  }
  const canAct = mission?.canAct ?? false;
  return (
    <View style={[styles.askcard, surface]}>
      <View style={styles.row}>
        <Icon name="sparkle" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {t("mobile.mission.review.ready")}
        </Text>
      </View>
      <Text variant="body" style={[styles.bold, styles.title]}>
        {r.title}
      </Text>
      {r.summary ? (
        <Text variant="small" tone="ink2" numberOfLines={6} style={styles.summary}>
          {r.summary}
        </Text>
      ) : null}
      {canAct ? (
        <View style={styles.acts}>
          <View style={styles.grow}>
            <Button
              variant="secondary"
              size="sm"
              wide
              label={t("mobile.mission.review.askChanges")}
              onPress={() =>
                sheet.open(
                  <PromptForm
                    title={t("mobile.mission.review.whatChange")}
                    placeholder={t("mobile.mission.review.changesPlaceholder")}
                    submitLabel={t("mobile.mission.review.sendChanges")}
                    onSubmit={(note) =>
                      act.mutateAsync({ outcome: "changes", note }).then(
                        () => {
                          sheet.close();
                          toast({
                            title: t("mobile.mission.review.changesSent"),
                            subtitle: t(`mobile.mission.review.changesSentSub${g}`, { name }),
                            ...(agentId ? { agentId } : {}),
                          });
                        },
                        () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                      )
                    }
                  />,
                )
              }
            />
          </View>
          <View style={styles.grow}>
            <Button
              variant="primary"
              size="sm"
              wide
              icon="check"
              label={t("mobile.mission.review.approve")}
              disabled={act.isPending}
              onPress={() =>
                act.mutate(
                  { outcome: "approve" },
                  {
                    onSuccess: () => {
                      successHaptic();
                      toast({
                        title: t("mobile.approval.approved"),
                        subtitle: t(`mobile.mission.review.approvedSub${g}`, { name }),
                        ...(agentId ? { agentId } : {}),
                      });
                    },
                    onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                  },
                )
              }
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ── Decision ─────────────────────────────────────────────────────────────────

export function DecisionCard({ missionId, decisionId }: { missionId: string; decisionId: string }) {
  const orgId = useOrgId();
  const decisions = useMissionDecisions(orgId, missionId);
  const mission = useMission(orgId, missionId);
  const decision = decisions.data?.find((d) => d.id === decisionId);
  if (!decision) return null;
  return <DecisionCardView decision={decision} mission={mission.data ?? null} />;
}

export function DecisionCardView({ decision: d, mission }: { decision: MissionDecision; mission: Mission | null }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const canAct = mission?.canAct ?? false;
  const canOpine = mission ? mission.role === "comment" : false;
  const choose = useMissionAct(orgId, d.missionId, (option: string) =>
    canAct
      ? api.missions.choose(orgId, d.missionId, d.id, option)
      : api.missions.opinion(orgId, d.missionId, d.id, option),
  );
  const taken = d.status === "taken";
  const picked = d.chosen;
  const rec = recommendedOption(d);
  const pick = (option: string) => {
    if (taken || !(canAct || canOpine) || choose.isPending) return;
    tapHaptic();
    choose.mutate(option, {
      onSuccess: () => {
        if (canAct)
          toast({
            title: t("mobile.mission.decision.noted"),
            subtitle: t("mobile.mission.decision.notedSub"),
            icon: "flag",
          });
      },
      onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
    });
  };
  return (
    <View style={[styles.askcard, surface]}>
      <View style={styles.row}>
        <Icon name="flag" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {taken ? t("mobile.mission.decision.decided") : t("mobile.mission.decision.title")}
        </Text>
      </View>
      <Text variant="body" style={[styles.bold, styles.title]}>
        {d.question}
      </Text>
      <View style={styles.opts}>
        {d.options.map((o) => {
          const on = picked === o;
          return (
            <Pressable
              key={o}
              onPress={() => pick(o)}
              disabled={taken || !(canAct || canOpine)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [
                styles.opt,
                { backgroundColor: on ? c.ink : c.sunken },
                pressed && styles.pressed,
              ]}
            >
              {on ? <Icon name="check" size={16} color={c.bg} /> : null}
              <Text variant="body" style={[styles.optText, { color: on ? c.bg : c.ink }]}>
                {o}
              </Text>
              {o === rec ? (
                <Text variant="caption" style={{ color: on ? c.bg : c.faint, opacity: on ? 0.7 : 1 }}>
                  {t("mobile.mission.decision.recommended")}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {d.why && !taken ? (
        <Text variant="caption" tone="faint" style={styles.summary}>
          {d.why}
        </Text>
      ) : null}
    </View>
  );
}

// ── Plan proposal ────────────────────────────────────────────────────────────

/** `meta.missionPlan`: before Start, the plan and Começar / Mudar algo; after, one quiet line. */
export function PlanCard({ missionId, goal }: { missionId: string; goal: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const sheet = useSheet();
  const dir = useDirectory();
  const mission = useMission(orgId, missionId);
  const control = useMissionControl(orgId);
  const m = mission.data;
  if (!m) return null;
  const name = dir.agentById.get(m.agentId)?.name ?? "";
  const g = genderOf(name);
  if (m.status !== "proposed") {
    return (
      <Pressable
        onPress={() => router.push(`/mission/${m.id}`)}
        accessibilityRole="button"
        style={[styles.done, surface]}
      >
        <Icon name="check" size={16} color={c.ok} />
        <Text variant="small" tone="muted" style={styles.grow} numberOfLines={2}>
          {t("mobile.mission.plan.started", { title: m.title || goal })}
        </Text>
        <Icon name="right" size={16} color={c.faint} />
      </Pressable>
    );
  }
  const items = (m.plan.items ?? []).filter((i) => i.status !== "dropped");
  return (
    <View style={[styles.askcard, surface]}>
      <View style={styles.row}>
        <Icon name="target" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {items.length > 0
            ? t("mobile.mission.plan.titleCount", { count: items.length })
            : t("mobile.mission.plan.title")}
        </Text>
      </View>
      <Text variant="body" style={[styles.bold, styles.title]}>
        {m.title || goal}
      </Text>
      {items.slice(0, 4).map((it, i) => (
        <View key={it.id} style={styles.planRow}>
          <View style={styles.n}>
            <Count value={i + 1} size={13} />
          </View>
          <Text variant="small" tone="ink2" style={styles.grow}>
            {it.title}
          </Text>
        </View>
      ))}
      {items.length > 4 ? (
        <Text variant="caption" tone="faint" style={styles.more}>
          {t("mobile.mission.plan.more", { count: items.length - 4 })}
        </Text>
      ) : null}
      {items.length === 0 ? (
        <Text variant="small" tone="muted">
          {t(`mobile.mission.plan.planning${g}`, { name })}
        </Text>
      ) : null}
      {m.canAct ? (
        <View style={styles.acts}>
          <View style={styles.grow}>
            <Button
              variant="secondary"
              size="sm"
              wide
              label={t("mobile.mission.plan.change")}
              onPress={() =>
                sheet.open(
                  <PromptForm
                    leading={<AgentFace agentId={m.agentId} size={32} />}
                    title={t("mobile.mission.plan.changeTitle")}
                    placeholder={t("mobile.mission.plan.changePlaceholder")}
                    submitLabel={t("mobile.app.send")}
                    onSubmit={(text) =>
                      api.missions.message(orgId, m.id, text).then(
                        (out) => {
                          sheet.close();
                          toast({
                            title: out.delivered
                              ? t("mobile.mission.plan.changeSent")
                              : t("mobile.mission.plan.changeQueued"),
                            agentId: m.agentId,
                          });
                        },
                        () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                      )
                    }
                  />,
                )
              }
            />
          </View>
          <View style={styles.grow}>
            <Button
              variant="primary"
              size="sm"
              wide
              label={t("mobile.mission.plan.start")}
              disabled={control.isPending || items.length === 0}
              onPress={() =>
                control.mutate(
                  { missionId: m.id, action: "start" },
                  {
                    onSuccess: () => {
                      successHaptic();
                      toast({
                        title: t("mobile.mission.plan.startedToast"),
                        subtitle: t(`mobile.mission.plan.startedSub${g}`, { name }),
                        agentId: m.agentId,
                      });
                    },
                    onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                  },
                )
              }
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  mcard: { marginTop: 8, padding: 12, borderRadius: 16, gap: 0 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  bold: { fontWeight: "600" },
  title: { marginTop: 5, marginBottom: 10 },
  titlePinned: { marginTop: 4, marginBottom: 8 },
  ft: { marginTop: 8, gap: 6 },
  askcard: { marginTop: 8, padding: 12, borderRadius: 16 },
  summary: { marginBottom: 10 },
  acts: { flexDirection: "row", gap: 8, marginTop: 4 },
  done: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
  },
  opts: { gap: 6 },
  opt: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 13 },
  optText: { flex: 1, fontWeight: "500" },
  planRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  n: { width: 16, alignItems: "flex-end" },
  more: { paddingLeft: 26, paddingBottom: 8 },
});
