import {
  type AgentQuestion,
  type Approval,
  type MessageConsultation,
  type ThreadInfo,
  useApi,
  useApproval,
  useApprovals,
  useCardApprovals,
  useDecideApproval,
  useDecideApprovals,
} from "@agenteschat/client";
import {
  approvalCardItems,
  approveAllScope,
  approveAlwaysOn,
  asOfNow,
  cardDeadline,
  itemOwnWords,
} from "@agenteschat/client/lib/approval-card";
import { aheadPhase } from "@agenteschat/client/lib/approval-kind";
import { approvalWhy } from "@agenteschat/client/lib/approval-origin";
import { approvalSummary, decisionOutcome } from "@agenteschat/client/lib/approval-words";
import { consultAskedKey } from "@agenteschat/client/lib/consult-group";
import { nextLabel } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, Count, HoldButton, Icon, Text, useToast } from "@/ui";
import { approvalAction, approvalRisk, approveAlwaysToast } from "../approvals/logic";
import {
  ApprovalAheadLine,
  ApprovalDetails,
  ApprovalEmailLetter,
  ApprovalMark,
  ApprovalTraits,
  ApproveAlways,
  approvalTitleText,
  useCancelAhead,
  useOriginShort,
} from "../approvals/parts";
import { chatHref, consultationHref } from "../links/logic";
import { AgentFace, Face, withAgentFaces } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { genderOf, previewOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { successHaptic, tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { askEndedAt } from "./ask-store";
import { AskButtons, AskCard, AskDone, AskFoot, ExpiryLine, useAskStore } from "./asks";
import { markName, threadFaces } from "./logic";

/**
 * The cards inside a message: the agent it consulted, the approval it asks for, an agent's question and a change
 * it proposes (each the request card, `asks.tsx`), and the link to its thread. Its tools are `ToolCalls.tsx`.
 */

// ── Consultation ─────────────────────────────────────────────────────────────

/**
 * "Infra respondeu": what the agent asked another agent before answering, in a private conversation. With the
 * conversation it was asked from (`channelId`), a tap opens the two agents' conversation on its own screen, as the
 * reply's block lines do: a long question or answer reads there, never stretching the chat. Without it (already
 * on that screen) it opens in place.
 */
export function ConsultationCard({
  askerId,
  consultation: cs,
  channelId,
}: {
  askerId: string;
  consultation: MessageConsultation;
  channelId?: string;
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
        : cs.kind === "note"
          ? t("chat.consultation.failedNote", { name, context: agentGrammar(name).context })
          : t(`mobile.chat.consult.failed${gn}`, { name });
  return (
    <View style={[styles.box, styles.cs, surface]}>
      <Pressable
        onPress={
          channelId
            ? () => {
                tapHaptic();
                router.push(consultationHref(cs.consultationId, channelId));
              }
            : () => setOpen((v) => !v)
        }
        accessibilityRole="button"
        accessibilityState={channelId ? undefined : { expanded: open }}
        style={styles.head}
      >
        <AgentFace agentId={cs.agentId} size={18} live={false} />
        <Text variant="small" tone="ink" style={styles.bold}>
          {head}
        </Text>
        <Text variant="small" tone="faint" numberOfLines={1} style={[styles.grow, open && styles.hidden]}>
          {cs.answer ? previewOf(cs.answer) : ""}
        </Text>
        {channelId ? (
          <Icon name="right" size={16} color={c.faint} />
        ) : (
          <View style={open ? styles.flip : undefined}>
            <Icon name="chev" size={16} color={c.faint} />
          </View>
        )}
      </Pressable>
      {open && !channelId ? (
        <View style={styles.csBody}>
          <Text variant="caption" tone="faint" style={styles.bold}>
            {withAgentFaces(t(consultAskedKey(cs), { name: asker }), [{ name: asker, agentId: askerId }], 12)}
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
 * An approval in the conversation: while it waits, the request card (`ApprovalAsk`); after, one line with
 * what happened. Requests the agent asked later in this conversation join its card (`messageId`): then one card
 * lists them all (`ApprovalGroupAsk`).
 */
export function ApprovalInline({ approvalId, messageId }: { approvalId: string; messageId: string }) {
  const orgId = useOrgId();
  const approval = useApproval(orgId, approvalId);
  const approvals = useApprovals(orgId);
  // Older than the list reaches: its card's requests by the card (the list holds everything newer than the first).
  const card = useCardApprovals(
    orgId,
    messageId,
    approvals.isSuccess && !approvals.data.some((x) => x.id === approvalId),
  );
  const a = approval.data;
  if (!a) return null;
  const items = approvalCardItems([...(approvals.data ?? []), ...(card.data ?? [])], messageId, a).map((x) =>
    asOfNow(x),
  );
  if (items.length > 1) {
    if (items.some((x) => x.status === "pending")) return <ApprovalGroupAsk items={items} />;
    return (
      <>
        {items.map((x) => (
          <ApprovalDone key={x.id} approval={x} />
        ))}
      </>
    );
  }
  if (a.status === "pending") return <ApprovalAsk approval={a} />;
  return <ApprovalDone approval={a} />;
}

/** One decided request, as one line: how it ended and its values, so several of one tool are told apart. */
function ApprovalDone({ approval: a }: { approval: Approval }) {
  const { t, i18n } = useTranslation();
  const meId = useMeId();
  const dir = useDirectory();
  const outcome = decisionOutcome(t, a, meId, (id) => dir.memberById.get(id)?.name);
  // Approved ahead and still to run: when it goes out, said on its line, and a way to withdraw it.
  const scheduled = aheadPhase(a) === "scheduled" && a.runAt;
  const cancelAhead = useCancelAhead();
  const words = [
    `${outcome}: ${markName(approvalTitleText(t, a))}`,
    approvalSummary(a, i18n.language),
    scheduled ? t("approval.ahead.scheduled", { when: nextLabel(i18n.language, scheduled) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const done = (
    <AskDone
      done={a.status === "approved"}
      words={words}
      at={scheduled ? null : askEndedAt(a)}
      more={
        a.reason
          ? {
              label: t("approval.seeDetails"),
              content: (
                <Text variant="small" tone="muted">
                  {t("approval.reasonLine", { reason: a.reason })}
                </Text>
              ),
            }
          : undefined
      }
    />
  );
  if (!scheduled || !a.canCancel) return done;
  return (
    <View>
      {done}
      <View style={styles.cancelAhead}>
        <Button
          variant="ghost"
          size="sm"
          label={t("approval.ahead.cancel")}
          loading={cancelAhead.pending}
          onPress={() => cancelAhead.cancel(a.id)}
        />
      </View>
    </View>
  );
}

/**
 * Several requests of one agent in one conversation on one card: each with its values and its own Aprovar /
 * "Agora não" while it waits, how it ended once decided, then "Aprovar tudo" / "Agora não para todos" over the
 * ones listed now (held when any is high risk) and the earliest deadline. Someone who may decide only some reads
 * that "Aprovar tudo" covers only those.
 */
function ApprovalGroupAsk({ items }: { items: Approval[] }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const asks = useAskStore();
  const one = useDecideApproval(orgId);
  const all = useDecideApprovals(orgId);
  const cancelAhead = useCancelAhead();
  const first = items[0];
  if (!first) return null;
  const name = dir.agentById.get(first.agentId)?.name ?? "";
  const g = genderOf(name);
  const waiting = items.filter((a) => a.status === "pending");
  const { ids, waiting: count, blocked } = approveAllScope(items);
  const high = items.some((a) => ids.includes(a.id) && approvalRisk(a) === "high");
  const ownerId = first.ownerUserId ?? dir.agentById.get(first.agentId)?.ownerUserId ?? null;
  const owner = ownerId ? dir.memberById.get(ownerId)?.name : undefined;
  const deadline = cardDeadline(items);
  const leadItem = waiting[0] ?? first;
  const always = approveAlwaysOn(items);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const done = (title: string) => {
    successHaptic();
    toast({ title, subtitle: t(`mobile.approval.approvedSub${g}`, { name }), agentId: first.agentId });
  };
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const approveAll = () =>
    all.mutate(
      { ids, decision: "approve" },
      {
        onSuccess: () => {
          for (const id of ids) asks?.settle(id);
          done(t("mobile.approval.approved"));
        },
        onError: failed,
      },
    );
  const refuseAll = () =>
    all.mutate(
      { ids, decision: "refuse" },
      {
        onSuccess: () => {
          for (const id of ids) asks?.settle(id);
        },
        onError: failed,
      },
    );
  return (
    <AskCard
      id={first.id}
      kind="approval"
      agentId={first.agentId}
      waitsFor={ids.length > 0 ? "you" : owner ? t("ask.waitingFor", { name: owner }) : null}
      lead={approvalWhy(leadItem) ?? t("approval.askMany", { count: waiting.length })}
      body={
        <View style={styles.items}>
          {items.map((a) => {
            const pending = a.status === "pending";
            const detail = a.email
              ? [a.email.to.join(", "), a.email.subject].filter(Boolean).join(" · ")
              : !a.connector
                ? a.detail
                : approvalSummary(a, i18n.language) || null;
            const own = itemOwnWords(a, leadItem);
            const scheduled = aheadPhase(a) === "scheduled" && a.runAt;
            return (
              <View key={a.id} style={[styles.item, { backgroundColor: c.sunken }, !pending && styles.itemDone]}>
                <View style={styles.itemRow}>
                  <ApprovalMark approval={a} size={24} />
                  <View style={styles.grow}>
                    <Text variant="subhead" tone="ink" numberOfLines={1} style={styles.bold}>
                      {approvalTitleText(t, a)}
                    </Text>
                    {detail ? (
                      <Text variant="footnote" tone="muted" numberOfLines={1}>
                        {detail}
                      </Text>
                    ) : null}
                    {own.why ? (
                      <Text variant="footnote" tone="ink">
                        {own.why}
                      </Text>
                    ) : null}
                    {own.origin ? (
                      <Text variant="footnote" tone="muted">
                        {tt(own.origin.key, own.origin.values)}
                      </Text>
                    ) : null}
                    <ApprovalAheadLine approval={a} />
                  </View>
                </View>
                {pending ? (
                  a.canDecide ? (
                    <View style={styles.itemActs}>
                      {approvalRisk(a) === "high" ? (
                        <HoldButton
                          size="sm"
                          label={t("mobile.approval.hold")}
                          holdLabel={t("mobile.approval.holding")}
                          onConfirm={() =>
                            one.mutate(
                              { id: a.id, decision: "approve" },
                              { onSuccess: () => asks?.settle(a.id), onError: failed },
                            )
                          }
                        />
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          icon="check"
                          label={t("mobile.approval.approve")}
                          disabled={one.isPending || all.isPending}
                          onPress={() =>
                            one.mutate(
                              { id: a.id, decision: "approve" },
                              { onSuccess: () => asks?.settle(a.id), onError: failed },
                            )
                          }
                        />
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        label={t("approval.notNow")}
                        onPress={() => router.push(`/approval/${a.id}?mode=refuse`)}
                      />
                    </View>
                  ) : null
                ) : (
                  <>
                    <Text variant="footnote" tone="muted">
                      {[
                        decisionOutcome(t, a, meId, (id) => dir.memberById.get(id)?.name),
                        scheduled && t("approval.ahead.scheduled", { when: nextLabel(i18n.language, scheduled) }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                    {scheduled && a.canCancel ? (
                      <View style={styles.cancelAhead}>
                        <Button
                          variant="ghost"
                          size="sm"
                          label={t("approval.ahead.cancel")}
                          loading={cancelAhead.pending}
                          onPress={() => cancelAhead.cancel(a.id)}
                        />
                      </View>
                    ) : null}
                  </>
                )}
                {always.has(a.id) ? (
                  <ApproveAlways
                    approval={a}
                    name={name}
                    disabled={one.isPending || all.isPending}
                    onPress={() =>
                      one.mutate(
                        { id: a.id, decision: "approve", always: true },
                        {
                          onSuccess: () => {
                            asks?.settle(a.id);
                            toast({ ...approveAlwaysToast(t, name), agentId: a.agentId });
                          },
                          onError: failed,
                        },
                      )
                    }
                  />
                ) : null}
              </View>
            );
          })}
          {blocked > 0 && ids.length > 0 ? (
            <Text variant="footnote" tone="muted">
              {t("approval.all.partial", {
                mine: ids.length,
                count,
                who: owner ?? t("approval.all.partialAdmin"),
              })}
            </Text>
          ) : null}
        </View>
      }
      foot={
        <AskFoot expiry={deadline ? <ExpiryLine createdAt={first.createdAt} expiresAt={deadline} /> : undefined}>
          {ids.length > 1 ? (
            <AskButtons
              primary={
                high ? (
                  <HoldButton
                    size="card"
                    label={t("approval.all.approve")}
                    holdLabel={t("mobile.approval.holding")}
                    onConfirm={approveAll}
                  />
                ) : (
                  <Button
                    variant="primary"
                    size="card"
                    wide
                    icon="check"
                    label={t("approval.all.approve")}
                    disabled={all.isPending}
                    onPress={approveAll}
                  />
                )
              }
              secondary={
                <Button
                  variant="secondary"
                  size="card"
                  wide
                  label={t("approval.all.refuse")}
                  disabled={all.isPending}
                  onPress={refuseAll}
                />
              }
            />
          ) : null}
        </AskFoot>
      }
    />
  );
}

/**
 * An approval waiting in the conversation, as the request card: what the agent said in its own words, the
 * exact action in the well with the app's mark ("Ver o e-mail" / "Ver detalhes" opens it whole, with where it
 * came from and "Aprovar sempre" where it is offered), then the strip with the fuse to its expiry and Aprovar
 * (held for a second when the risk is high) beside "Agora não" (the request's sheet, which asks why: a lesson
 * for the agent). Who can't decide sees who it waits for.
 */
function ApprovalAsk({ approval: a }: { approval: Approval }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const asks = useAskStore();
  const decide = useDecideApproval(orgId);
  const origin = useOriginShort(a);
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
          asks?.settle(a.id);
          toast({
            ...(always
              ? approveAlwaysToast(t, name)
              : {
                  title: t("mobile.approval.approved"),
                  subtitle: a.runAt
                    ? t("mobile.approval.approvedAhead", { when: nextLabel(i18n.language, a.runAt) })
                    : t(`mobile.approval.approvedSub${g}`, { name }),
                }),
            agentId: a.agentId,
          });
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  // An email says to whom and about what; a connector's detail is its raw call (`tool · key=value`), so its
  // values in words instead, the call under "Ver detalhes".
  const detail = a.email
    ? [a.email.to.join(", "), a.email.subject].filter(Boolean).join(" · ")
    : !a.connector
      ? a.detail
      : approvalSummary(a, i18n.language) || null;
  return (
    <AskCard
      id={a.id}
      kind="approval"
      agentId={a.agentId}
      waitsFor={a.canDecide ? "you" : owner ? t("ask.waitingFor", { name: owner }) : null}
      lead={approvalWhy(a) ?? t("approval.askPlain")}
      well={{
        tile: <ApprovalMark approval={a} size={32} />,
        title: approvalTitleText(t, a),
        detail,
        more: {
          label: a.email ? t("approval.seeEmail") : t("approval.seeDetails"),
          content: (
            <>
              {a.email ? (
                <ApprovalEmailLetter email={a.email} />
              ) : (
                <>
                  <ApprovalDetails approval={a} stacked />
                  <ApprovalTraits approval={a} />
                </>
              )}
              {origin ? (
                <View style={styles.origin}>
                  <Icon name="clock" size={13} color={c.muted} />
                  <Text variant="footnote" tone="muted" style={styles.grow}>
                    {origin}
                  </Text>
                </View>
              ) : null}
              {a.canDecide ? (
                <ApproveAlways approval={a} name={name} disabled={decide.isPending} onPress={() => approve(true)} />
              ) : null}
            </>
          ),
        },
      }}
      body={<ApprovalAheadLine approval={a} />}
      foot={
        <AskFoot expiry={<ExpiryLine createdAt={a.createdAt} expiresAt={a.expiresAt} />}>
          {a.canDecide ? (
            <AskButtons
              primary={
                high ? (
                  <HoldButton
                    size="card"
                    label={t("mobile.approval.hold")}
                    holdLabel={t("mobile.approval.holding")}
                    onConfirm={() => approve()}
                  />
                ) : (
                  <Button
                    variant="primary"
                    size="card"
                    wide
                    icon="check"
                    label={approvalAction(a) === "draft" ? t("approval.approve.draft") : t("mobile.approval.approve")}
                    disabled={decide.isPending}
                    onPress={() => approve()}
                  />
                )
              }
              secondary={
                <Button
                  variant="secondary"
                  size="card"
                  wide
                  label={t("approval.notNow")}
                  onPress={() => router.push(`/approval/${a.id}?mode=refuse`)}
                />
              }
            />
          ) : owner ? null : (
            <Text variant="small" tone="muted">
              {t("approval.waitingAdmin")}
            </Text>
          )}
        </AskFoot>
      }
    />
  );
}

// ── Question (ask_user) ──────────────────────────────────────────────────────

/**
 * An agent's question (`ask_user`, `meta.question`) as the request card: the question, then the choices as
 * full-width rows and "Outra resposta" for a free answer beside them; with no choices, just Responder. Once
 * answered, one line with the answer. Anyone in the conversation may answer.
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
  const asks = useAskStore();
  const [answered, setAnswered] = useState<AgentQuestion | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const q = answered ?? question;
  const choices = q.choices ?? [];

  const answer = (input: { choice: string } | { text: string }) => {
    setPicking("choice" in input ? input.choice : null);
    return api.questions
      .answer(orgId, q.id, input)
      .then((res) => {
        tapHaptic();
        asks?.settle(q.id);
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
    const said = markName(q.answer ?? "");
    return (
      <AskDone
        done
        words={
          q.withdrawn
            ? t("question.withdrawn", agentGrammar(dir.anyAgent(q.agentId)?.name ?? t("channel.unknownAgent")))
            : q.answer === null
              ? t("mobile.chat.question.closed")
              : who
                ? t("mobile.chat.question.answered", { name: who, answer: said })
                : t("mobile.chat.question.answeredByYou", { answer: said })
        }
      />
    );
  }
  // A free answer in a sheet: "Outra resposta" beside the choices, or the question's only button.
  const write = () =>
    sheet.open(
      <PromptForm
        title={q.text}
        placeholder={t("mobile.chat.question.placeholder")}
        submitLabel={t("mobile.app.send")}
        onSubmit={(text) => answer({ text }).then(() => sheet.close())}
      />,
    );
  return (
    <AskCard
      id={q.id}
      kind="question"
      agentId={q.agentId}
      waitsFor="you"
      lead={q.text}
      foot={
        <AskFoot>
          {choices.length > 0 ? (
            <View style={styles.opts}>
              {choices.map((choice) => {
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
                onPress={write}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.opt,
                  styles.other,
                  { borderColor: c.line2 },
                  pressed && styles.optPressed,
                ]}
              >
                <Text variant="callout" tone="muted">
                  {t("ask.otherAnswer")}
                </Text>
              </Pressable>
            </View>
          ) : (
            <Button variant="primary" size="card" wide label={t("question.answer")} onPress={write} />
          )}
        </AskFoot>
      }
    />
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
  origin: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  // Requests sharing one card: each a well of its own, decided ones quieter.
  items: { gap: 8, marginTop: 10 },
  item: { gap: 8, padding: 10, borderRadius: 12 },
  itemDone: { opacity: 0.7 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  itemActs: { flexDirection: "row", gap: 8 },
  // A question's answers: full-width rows in the card's strip.
  opts: { gap: 8 },
  // Under its done line, at the left edge where the line's words start.
  cancelAhead: { alignSelf: "flex-start", marginTop: -4 },
  opt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  optPressed: { transform: [{ scale: 0.98 }] },
  other: { backgroundColor: "transparent", borderWidth: 1 },
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
