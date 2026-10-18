import { type MessageConsultation, type ThreadInfo, useApi, useApproval, useRun } from "@agenteschat/client";
import { toolLabel, workFromSteps } from "@agenteschat/client/lib/work";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { Button, Count, Icon, Text, useToast } from "@/ui";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { genderOf, previewOf } from "../shared/logic";
import { tapHaptic, useSurface } from "../shared/parts";
import { threadFaces } from "./logic";

/**
 * The cards inside a message: the steps it took (collapsed), the agent it
 * consulted, a file, the approval it asks for, and the link to its thread.
 */

// ── Steps ────────────────────────────────────────────────────────────────────

/** "3 passos" under an agent's reply; opening it loads what it did. */
export function StepsCard({ runId, steps }: { runId: string; steps: number }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const surface = useSurface();
  const [open, setOpen] = useState(false);
  const run = useRun(orgId, open ? runId : null);
  const work = run.data ? workFromSteps(run.data.steps, run.data.run) : null;
  const lines = work
    ? [
        ...work.narration.map((n) => ({ key: n.key, at: n.at, text: n.text, note: true })),
        ...work.steps.map((s, i) => ({
          key: s.key,
          at: i + 0.5,
          text: t(`chat.work.step.${s.kind}`, {
            app: s.app ?? "",
            tool: toolLabel(s.tool),
            defaultValue: toolLabel(s.tool),
          }),
          note: false,
        })),
      ].sort((a, b) => a.at - b.at)
    : [];
  return (
    <View style={[styles.box, surface]}>
      <Pressable
        onPress={() => {
          tapHaptic();
          setOpen((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.head}
      >
        <Icon name="check" size={16} color={c.ok} />
        <Text variant="small" tone="ink" style={styles.bold}>
          {t("mobile.chat.steps", { count: steps })}
        </Text>
        <View style={styles.grow} />
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={16} color={c.faint} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.body}>
          {run.isError ? (
            <Text variant="small" tone="muted">
              {t("mobile.chat.stepsFailed")}
            </Text>
          ) : !work ? (
            <Text variant="small" tone="faint">
              {t("mobile.common.loading")}
            </Text>
          ) : lines.length === 0 ? (
            <Text variant="small" tone="muted">
              {t("mobile.chat.stepsNone")}
            </Text>
          ) : (
            lines.map((l) => (
              <View key={l.key} style={styles.step}>
                {l.note ? <Icon name="chat" size={16} color={c.faint} /> : <Icon name="check" size={16} color={c.ok} />}
                <Text variant="small" tone={l.note ? "muted" : "ink2"} style={styles.grow}>
                  {l.text}
                </Text>
              </View>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

// ── Consultation ─────────────────────────────────────────────────────────────

/** "Infra respondeu": what the agent asked another agent before answering, in a private conversation. */
export function ConsultationCard({
  askerId,
  consultation: cs,
}: {
  askerId: string;
  consultation: MessageConsultation;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const surface = useSurface();
  const [open, setOpen] = useState(false);
  const asker = dir.agentById.get(askerId)?.name ?? "";
  const name = dir.agentById.get(cs.agentId)?.name ?? "";
  const ga = genderOf(asker);
  const gn = genderOf(name);
  const head =
    cs.status === "answered"
      ? t("mobile.chat.consult.answered", { name })
      : cs.status === "expired"
        ? t(`mobile.chat.consult.expired${gn}`, { name })
        : t(`mobile.chat.consult.failed${gn}`, { name });
  return (
    <View style={[styles.box, styles.cs, surface]}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.head}
      >
        <AgentFace agentId={cs.agentId} size={18} live={false} />
        <Text variant="small" tone="ink" style={styles.bold}>
          {head}
        </Text>
        <Text variant="small" tone="faint" numberOfLines={1} style={[styles.grow, open && styles.hidden]}>
          {cs.answer ? previewOf(cs.answer) : ""}
        </Text>
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={16} color={c.faint} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.csBody}>
          <Text variant="caption" tone="faint" style={styles.bold}>
            {t("mobile.chat.consult.asked", { name: asker })}
          </Text>
          <Text variant="small" tone="muted">
            {cs.question}
          </Text>
          <Text variant="caption" tone="faint" style={[styles.bold, styles.gap]}>
            {t(`mobile.chat.consult.answerOf${gn}`, { name })}
          </Text>
          <Text variant="small" tone="ink2">
            {cs.answer ?? t("mobile.chat.consult.noAnswer")}
          </Text>
          <View style={styles.foot}>
            <Icon name="eyeoff" size={13} color={c.faint} />
            <Text variant="caption" tone="faint" style={styles.grow}>
              {t(`mobile.chat.consult.private${ga}${gn}`, { from: asker, to: name })}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ── File ─────────────────────────────────────────────────────────────────────

/** A file on a message: tapping opens it (a short-lived link from the server). */
export function FileCard({
  id,
  version,
  title,
  deleted,
}: {
  id: string;
  version?: number;
  title: string;
  deleted: boolean;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const open = () => {
    if (deleted) return;
    api.artifacts
      .download(orgId, id, version)
      .then(({ url }) => Linking.openURL(url))
      .catch(() => toast({ title: t("mobile.chat.fileFailed"), icon: "x" }));
  };
  return (
    <Pressable
      onPress={open}
      disabled={deleted}
      accessibilityRole="button"
      style={({ pressed }) => [styles.art, surface, pressed && styles.pressed]}
    >
      <View style={[styles.thumb, { backgroundColor: c.sunken }]}>
        <Icon name="doc" size={22} color={c.muted} />
      </View>
      <View style={styles.grow}>
        <Text variant="body" style={styles.bold} numberOfLines={1}>
          {title || t("mobile.chat.file")}
        </Text>
        <Text variant="caption" tone="faint">
          {deleted ? t("mobile.chat.fileDeleted") : t("mobile.chat.fileOpen")}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Approval ─────────────────────────────────────────────────────────────────

/** "Pede sua aprovação" in the conversation; after, one line with what happened. */
export function ApprovalInline({ approvalId }: { approvalId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const surface = useSurface();
  const approval = useApproval(orgId, approvalId);
  const a = approval.data;
  if (!a) return null;
  if (a.status !== "pending") {
    const ok = a.status === "approved";
    return (
      <View style={[styles.done, surface]}>
        <Icon name={ok ? "check" : "x"} size={16} color={ok ? c.ok : c.muted} />
        <Text variant="small" tone="muted" style={styles.grow}>
          {t(`mobile.chat.approval.${a.status}`, { title: a.title })}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.askcard, surface]}>
      <View style={styles.label}>
        <Icon name="shield" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {t("mobile.chat.approval.asks")}
        </Text>
      </View>
      <Text variant="body" style={[styles.bold, styles.h4]}>
        {a.title}
      </Text>
      <Button
        variant="primary"
        size="sm"
        wide
        label={t("mobile.chat.approval.see")}
        onPress={() => router.push(`/approval/${a.id}`)}
      />
    </View>
  );
}

// ── Thread link ──────────────────────────────────────────────────────────────

/** "3 respostas" with who wrote; opens the thread. */
export function ThreadLink({ thread }: { thread: ThreadInfo }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const when = useWhen();
  const faces = threadFaces(thread.participants, 2);
  return (
    <Pressable
      onPress={() => router.push(chatHref(thread.channelId, thread.id))}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.chat.replies", { count: thread.replyCount })}
      style={({ pressed }) => [styles.tlink, surface, pressed && styles.pressed]}
    >
      <View style={styles.faces}>
        {faces.map((f, i) => (
          <View key={`${f.type}:${f.id}`} style={i > 0 ? styles.overlap : undefined}>
            <Face who={f} size={20} live={false} />
          </View>
        ))}
      </View>
      {thread.replyCount > 0 ? (
        <>
          <Count value={thread.replyCount} size={13} />
          <Text variant="small" tone="ink2" style={styles.bold}>
            {t("mobile.chat.repliesWord", { count: thread.replyCount })}
          </Text>
        </>
      ) : (
        <Text variant="small" tone="ink2" style={styles.bold}>
          {t("mobile.chat.thread")}
        </Text>
      )}
      <Text variant="small" tone="faint" numberOfLines={1} style={styles.shrink}>
        {thread.state === "closed" ? ` · ${t("mobile.chat.closed")}` : ` · ${when.short(thread.lastActivityAt)}`}
      </Text>
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 8, borderRadius: 14, overflow: "hidden" },
  cs: { marginTop: 6, marginBottom: 8 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 42,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  body: { paddingHorizontal: 14, paddingBottom: 12, gap: 2 },
  step: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 5 },
  csBody: { paddingLeft: 40, paddingRight: 14, paddingBottom: 14, gap: 2 },
  gap: { marginTop: 8 },
  foot: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  hidden: { opacity: 0 },
  flip: { transform: [{ rotate: "180deg" }] },
  pressed: { opacity: 0.85 },
  art: { marginTop: 8, flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: 16 },
  thumb: { width: 52, height: 52, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  done: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
  },
  askcard: { marginTop: 8, padding: 12, borderRadius: 16 },
  label: { flexDirection: "row", alignItems: "center", gap: 8 },
  h4: { marginTop: 6, marginBottom: 10 },
  tlink: {
    marginTop: 8,
    alignSelf: "flex-start",
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingLeft: 8,
    paddingRight: 12,
    borderRadius: 12,
  },
  faces: { flexDirection: "row", marginRight: 2 },
  overlap: { marginLeft: -6 },
});
