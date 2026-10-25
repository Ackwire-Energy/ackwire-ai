import {
  type AgentQuestion,
  type MessageConsultation,
  type ThreadInfo,
  useApi,
  useApproval,
  useDecideApproval,
  useRun,
} from "@agenteschat/client";
import { toolLabel, workFromSteps } from "@agenteschat/client/lib/work";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Button, Chip, Count, HoldButton, Icon, LineIcon, Text, useReducedMotion, useToast } from "@/ui";
import { approvalAction, approvalRisk } from "../approvals/logic";
import {
  ApprovalDetails,
  ApprovalEmailLetter,
  ApprovalFuse,
  ApprovalSaid,
  ApprovalTraits,
  approvalTitleText,
  useOriginShort,
} from "../approvals/parts";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { genderOf, previewOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { successHaptic, tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { threadFaces } from "./logic";
import { recentTurn } from "./turn";

/**
 * The cards inside a message: the steps it took (collapsed), the agent it
 * consulted, the approval it asks for, an agent's question, and the
 * link to its thread.
 */

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * "3 passos" above an agent's reply, a quiet pill; opening it loads what it did, one line per step. Right
 * after the reply took its live block's place, it fades in as the work folds away.
 */
export function StepsCard({ runId, steps }: { runId: string; steps: number }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [folding] = useState(() => recentTurn(runId, Date.now()) !== null);
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
    <Animated.View entering={folding && !reduced ? FadeIn.duration(400) : undefined} style={styles.steps}>
      <Pressable
        onPress={() => {
          tapHaptic();
          setOpen((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.stp, { backgroundColor: c.sunken }, pressed && styles.pressed]}
      >
        <Icon name="check" size={14} color={c.muted} />
        <Text variant="footnote" tone="muted" style={styles.medium}>
          {t("mobile.chat.steps", { count: steps })}
        </Text>
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={13} color={c.muted} />
        </View>
      </Pressable>
      {open ? (
        <View style={[styles.stl, { backgroundColor: c.sunken }]}>
          {run.isError ? (
            <Text variant="small" tone="muted" style={styles.stlNote}>
              {t("mobile.chat.stepsFailed")}
            </Text>
          ) : !work ? (
            <Text variant="small" tone="faint" style={styles.stlNote}>
              {t("mobile.common.loading")}
            </Text>
          ) : lines.length === 0 ? (
            <Text variant="small" tone="muted" style={styles.stlNote}>
              {t("mobile.chat.stepsNone")}
            </Text>
          ) : (
            lines.map((l, i) => (
              <View
                key={l.key}
                style={[styles.step, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 }]}
              >
                <LineIcon name={l.note ? "chat" : "check"} size={15} color={l.note ? c.faint : c.ok} variant="small" />
                <Text variant="small" tone={l.note ? "muted" : "ink2"} style={styles.grow}>
                  {l.text}
                </Text>
              </View>
            ))
          )}
        </View>
      ) : null}
    </Animated.View>
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

// ── Approval ─────────────────────────────────────────────────────────────────

/**
 * "Pede sua aprovação" in the conversation: the exact action, its values, the
 * fuse until it expires, Recusar and Aprovar (held for a second when the risk is high). After, one line
 * with what happened. Someone who can't decide sees the request and opens it.
 */
export function ApprovalInline({ approvalId }: { approvalId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const surface = useSurface();
  const raised = useSurface("e2");
  const approval = useApproval(orgId, approvalId);
  const decide = useDecideApproval(orgId);
  const a = approval.data;
  const origin = useOriginShort({ origin: a?.origin ?? null });
  if (!a) return null;
  if (a.status !== "pending") {
    const ok = a.status === "approved";
    return (
      <View style={[styles.done, surface]}>
        <Icon name={ok ? "checkc" : "x"} size={16} color={ok ? c.ok : c.muted} />
        <Text variant="small" tone="muted" style={styles.grow}>
          {t(`mobile.chat.approval.${a.status}`, { title: approvalTitleText(t, a) })}
        </Text>
      </View>
    );
  }
  const name = dir.agentById.get(a.agentId)?.name ?? "";
  const g = genderOf(name);
  const high = approvalRisk(a) === "high";
  const approve = () =>
    decide.mutate(
      { id: a.id, decision: "approve" },
      {
        onSuccess: () => {
          if (!high) successHaptic();
          toast({
            title: t("mobile.approval.approved"),
            subtitle: t(`mobile.approval.approvedSub${g}`, { name }),
            agentId: a.agentId,
          });
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  return (
    <View style={[styles.askcard, raised]}>
      <View style={styles.label}>
        <LineIcon name="shield" size={15} color={c.amber} variant="footnote" />
        <Text variant="footnote" tone="muted" style={[styles.medium, styles.grow]} numberOfLines={1}>
          {origin ? `${t("mobile.chat.approval.asks")} · ${origin}` : t("mobile.chat.approval.asks")}
        </Text>
        {high ? <Chip label={t("mobile.approval.highRisk")} /> : null}
      </View>
      <Text variant="title" style={styles.h4}>
        {approvalTitleText(t, a)}
      </Text>
      <View style={styles.askBody}>
        {a.email ? <ApprovalEmailLetter email={a.email} /> : <ApprovalDetails approval={a} />}
        <ApprovalSaid approval={a} name={name} />
        <ApprovalTraits approval={a} />
        <ApprovalFuse approval={a} />
      </View>
      {a.canDecide ? (
        <View style={styles.acts}>
          <Button
            variant="secondary"
            label={t("mobile.approval.refuse")}
            onPress={() => router.push(`/approval/${a.id}?mode=refuse`)}
          />
          <View style={styles.grow}>
            {high ? (
              <HoldButton
                label={t("mobile.approval.hold")}
                holdLabel={t("mobile.approval.holding")}
                onConfirm={approve}
              />
            ) : (
              <Button
                variant="primary"
                wide
                icon="check"
                label={approvalAction(a) === "draft" ? t("approval.approve.draft") : t("mobile.approval.approve")}
                disabled={decide.isPending}
                onPress={approve}
              />
            )}
          </View>
        </View>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          wide
          label={t("mobile.chat.approval.see")}
          onPress={() => router.push(`/approval/${a.id}`)}
        />
      )}
    </View>
  );
}

// ── Question (ask_user) ──────────────────────────────────────────────────────

/**
 * An agent's question (`ask_user`, `meta.question`): the choices as buttons, or "Responder do meu jeito"
 * for a free answer; once answered, one line with the answer. Anyone in the conversation may answer.
 */
export function QuestionCard({ question }: { question: AgentQuestion }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const surface = useSurface();
  const [answered, setAnswered] = useState<AgentQuestion | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const q = answered ?? question;
  const agentName = dir.agentById.get(q.agentId)?.name ?? t("mobile.chat.someone");
  const from = t(`mobile.chat.question.from${genderOf(agentName)}`, { name: agentName });

  const answer = (input: { choice: string } | { text: string }) => {
    setPicking("choice" in input ? input.choice : null);
    return api.questions
      .answer(orgId, q.id, input)
      .then((res) => {
        tapHaptic();
        setAnswered({ ...res, answer: res.answer ?? ("choice" in input ? input.choice : input.text) });
      })
      .catch((err: unknown) =>
        toast({
          title: (err as { status?: number }).status === 409 ? t("mobile.chat.question.taken") : t("mobile.app.failed"),
          icon: "x",
        }),
      )
      .finally(() => setPicking(null));
  };

  if (q.status === "answered") {
    const who = q.answeredByUserId && q.answeredByUserId !== meId ? dir.memberById.get(q.answeredByUserId)?.name : null;
    return (
      <View style={[styles.qdone, surface]}>
        <Icon name="checkc" size={16} color={c.ok} />
        <Text variant="small" tone="muted" style={styles.shrink}>
          {who
            ? t("mobile.chat.question.answered", { name: who, answer: q.answer ?? "" })
            : t("mobile.chat.question.answeredByYou", { answer: q.answer ?? "" })}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.qcard, surface]} accessibilityLabel={from}>
      <View style={styles.label}>
        <Icon name="help" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {from}
        </Text>
      </View>
      <Text variant="title" style={styles.qtitle}>
        {q.text}
      </Text>
      <View style={styles.opts}>
        {(q.choices ?? []).map((choice) => {
          const on = picking === choice;
          return (
            <Pressable
              key={choice}
              disabled={picking !== null}
              onPress={() => void answer({ choice })}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: picking !== null }}
              style={({ pressed }) => [
                styles.opt,
                { backgroundColor: on ? c.ink : c.sunken },
                pressed && styles.optPressed,
              ]}
            >
              <Text variant="callout" style={{ color: on ? c.bg : c.ink }}>
                {choice}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          disabled={picking !== null}
          onPress={() =>
            sheet.open(
              <PromptForm
                title={q.text}
                placeholder={t("mobile.chat.question.placeholder")}
                submitLabel={t("mobile.app.send")}
                onSubmit={(text) => answer({ text }).then(() => sheet.close())}
              />,
            )
          }
          accessibilityRole="button"
          style={({ pressed }) => [styles.opt, styles.other, { borderColor: c.line2 }, pressed && styles.optPressed]}
        >
          <Icon name="pen" size={17} color={c.muted} />
          <Text variant="callout" tone="muted">
            {t("mobile.chat.question.own")}
          </Text>
        </Pressable>
      </View>
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
  steps: { marginTop: 4, marginBottom: 8, alignItems: "flex-start" },
  stp: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 30,
    paddingLeft: 9,
    paddingRight: 11,
    borderRadius: 15,
  },
  stl: { alignSelf: "stretch", marginTop: 6, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14 },
  stlNote: { paddingVertical: 6 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 9, paddingVertical: 6 },
  csBody: { paddingLeft: 40, paddingRight: 14, paddingBottom: 14, gap: 2 },
  gap: { marginTop: 8 },
  foot: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  hidden: { opacity: 0 },
  flip: { transform: [{ rotate: "180deg" }] },
  pressed: { opacity: 0.85 },
  done: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 20,
  },
  askcard: { marginTop: 12, padding: 14, borderRadius: 20 },
  label: { flexDirection: "row", alignItems: "center", gap: 6 },
  medium: { fontWeight: "500" },
  h4: { marginTop: 6, marginBottom: 10, fontSize: 18, lineHeight: 23, letterSpacing: -0.27 },
  askBody: { gap: 12, marginBottom: 12 },
  acts: { flexDirection: "row", gap: 8, alignItems: "center" },
  qcard: { marginTop: 12, padding: 14, borderRadius: 20 },
  qtitle: { marginTop: 5, marginBottom: 12 },
  opts: { gap: 6 },
  opt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
  },
  optPressed: { transform: [{ scale: 0.98 }] },
  other: { backgroundColor: "transparent", borderWidth: 1 },
  qdone: {
    marginTop: 12,
    alignSelf: "flex-start",
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 16,
  },
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
