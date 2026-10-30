import {
  type AgentQuestion,
  type Approval,
  type MessageConsultation,
  type ThreadInfo,
  useApi,
  useApproval,
  useDecideApproval,
} from "@agenteschat/client";
import { approvalWhy } from "@agenteschat/client/lib/approval-origin";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Button, Count, HoldButton, Icon, Text, useReducedMotion, useToast } from "@/ui";
import { approvalAction, approvalRisk, approveAlwaysOffered, approveAlwaysToast } from "../approvals/logic";
import {
  ApprovalDetails,
  ApprovalEmailLetter,
  ApprovalFuse,
  ApprovalMark,
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
import { MessageText } from "./MessageText";

/**
 * The cards inside a message: the agent it consulted, the approval it asks for (a question, no card), an
 * agent's question, and the link to its thread. Its tools are `ToolCalls.tsx`.
 */

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
 * An approval in the conversation: while it waits, the agent asking (`ApprovalAsk`); after, one line with
 * what happened.
 */
export function ApprovalInline({ approvalId }: { approvalId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const surface = useSurface();
  const approval = useApproval(orgId, approvalId);
  const a = approval.data;
  if (!a) return null;
  if (a.status === "pending") return <ApprovalAsk approval={a} />;
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

/**
 * A request waiting in the conversation, as the agent asking, no card: what it said in its
 * own words, the exact action in one line with the app's mark, "Ver o e-mail" / "Ver detalhes" opening it
 * whole, then Aprovar (held for a second when the risk is high), "Agora não" (the request's sheet, which
 * asks why: a lesson for the agent), "Aprovar sempre" where it is offered (a plain tap) and the fuse to its
 * expiry. Who can't decide sees who it waits for.
 */
function ApprovalAsk({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const reduced = useReducedMotion();
  const decide = useDecideApproval(orgId);
  const origin = useOriginShort(a);
  const [open, setOpen] = useState(false);
  const name = dir.agentById.get(a.agentId)?.name ?? "";
  const g = genderOf(name);
  const high = approvalRisk(a) === "high";
  const ownerId = a.ownerUserId ?? dir.agentById.get(a.agentId)?.ownerUserId ?? null;
  const owner = ownerId ? dir.memberById.get(ownerId)?.name : undefined;
  const approve = (always = false) =>
    decide.mutate(
      { id: a.id, decision: "approve", always },
      {
        onSuccess: () => {
          if (!high) successHaptic();
          toast({
            ...(always
              ? approveAlwaysToast(t, name)
              : { title: t("mobile.approval.approved"), subtitle: t(`mobile.approval.approvedSub${g}`, { name }) }),
            agentId: a.agentId,
          });
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  return (
    <Animated.View entering={reduced ? undefined : FadeIn.duration(300)} style={styles.ask}>
      <MessageText body={approvalWhy(a) ?? t("approval.askPlain")} selectable={false} />
      <View style={styles.action}>
        <ApprovalMark approval={a} />
        <Text variant="small" tone="ink" style={[styles.bold, styles.grow]}>
          {approvalTitleText(t, a)}
        </Text>
      </View>
      {/* A connector's detail is its raw call (`tool · key=value`); its values are under "Ver detalhes". */}
      {!a.email && a.detail && !a.connector ? (
        <Text variant="footnote" tone="muted">
          {a.detail}
        </Text>
      ) : null}
      {origin ? (
        <Text variant="footnote" tone="muted">
          {origin}
        </Text>
      ) : null}
      <Pressable
        onPress={() => {
          tapHaptic();
          setOpen((o) => !o);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        style={({ pressed }) => [styles.more, pressed && styles.pressed]}
      >
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={13} color={c.muted} />
        </View>
        <Text variant="footnote" tone="muted" style={styles.bold}>
          {a.email ? t("approval.seeEmail") : t("approval.seeDetails")}
        </Text>
      </Pressable>
      {open ? (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(220)} style={styles.exact}>
          {a.email ? (
            <ApprovalEmailLetter email={a.email} />
          ) : (
            <>
              <ApprovalDetails approval={a} />
              <ApprovalTraits approval={a} />
            </>
          )}
        </Animated.View>
      ) : null}
      {a.canDecide ? (
        <View style={styles.acts}>
          <View style={styles.approve}>
            {high ? (
              <HoldButton
                label={t("mobile.approval.hold")}
                holdLabel={t("mobile.approval.holding")}
                onConfirm={() => approve()}
              />
            ) : (
              <Button
                variant="primary"
                wide
                icon="check"
                label={approvalAction(a) === "draft" ? t("approval.approve.draft") : t("mobile.approval.approve")}
                disabled={decide.isPending}
                onPress={() => approve()}
              />
            )}
          </View>
          <View style={styles.grow}>
            <Button
              variant="secondary"
              wide
              label={t("approval.notNow")}
              onPress={() => router.push(`/approval/${a.id}?mode=refuse`)}
            />
          </View>
        </View>
      ) : (
        <Text variant="small" tone="muted">
          {owner ? t("approval.waitingFor", { name: owner }) : t("approval.waitingAdmin")}
        </Text>
      )}
      {approveAlwaysOffered(a) ? (
        <Button
          variant="ghost"
          wide
          label={t("approval.always.button")}
          disabled={decide.isPending}
          onPress={() => approve(true)}
        />
      ) : null}
      <ApprovalFuse approval={a} />
    </Animated.View>
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
  // The request as the agent's next words: no card, the action and the decision under them.
  ask: { marginTop: 4, marginBottom: 4, gap: 8 },
  action: { flexDirection: "row", alignItems: "center", gap: 8 },
  more: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: 28 },
  exact: { gap: 10 },
  label: { flexDirection: "row", alignItems: "center", gap: 6 },
  acts: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 4 },
  approve: { flex: 1.5 },
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
