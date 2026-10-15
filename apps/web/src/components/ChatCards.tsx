import { Button, Chip, Diff, diffLines, Field, Textarea } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useDecideProposal, useProposals } from "@/api/queries";
import type { AgentQuestion, MemoryUpdate } from "@/api/types";
import { useDirectory } from "@/hooks/useDirectory";
import { agentGrammar } from "@/lib/grammar";
import { useToast } from "@/lib/toast";
import { useLive, useLiveStore } from "@/realtime/context";
import { useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";
import { CardSky, colorOf } from "./Sky";

/**
 * "Memória atualizada" in the chat (`memory.updated`): what the agent
 * remembered, forgot or updated because a person asked, a link to what it
 * knows, and "Desfazer" (`POST …/memories/{id}/revert`). A proposed change
 * shows the proposal inline instead.
 */
export function MemoryChangeCard({ update, agentId }: { update: MemoryUpdate; agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const [undone, setUndone] = useState(false);
  const revert = useMutation({
    mutationFn: () => api.memory.revert(org.id, update.itemId),
    onSuccess: () => {
      setUndone(true);
      void qc.invalidateQueries({ queryKey: keys.memory(org.id, agentId) });
    },
  });
  if (update.action === "proposed") return update.proposalId ? <InlineProposal proposalId={update.proposalId} /> : null;
  const name = dir.agentById.get(agentId)?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(t, name);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      className="ac-approval ac-approval--done ac-memory-card"
      role="group"
      aria-label={t("memoryCard.group", { name })}
    >
      <div className="ac-approval__head">
        <span className="ac-approval__who">
          <b>{t(`memoryCard.${update.action}`, { name })}</b>
        </span>
        <Chip icon={undone ? "close" : "check"}>{undone ? t("memoryCard.undone") : t("memoryCard.chip")}</Chip>
      </div>
      <p className={update.action === "forgot" ? "ac-approval__title struck" : "ac-approval__title"}>{update.text}</p>
      {update.action === "updated" && update.previousText && (
        <p className="small muted" style={{ margin: 0 }}>
          {t("memoryCard.was", { text: update.previousText })}
        </p>
      )}
      <div className="ac-approval__actions">
        <Button asChild variant="ghost" size="sm">
          <Link to="/org/$orgId/agents/$agentId/memory" params={{ orgId: org.id, agentId }}>
            {t("memoryCard.open", g)}
          </Link>
        </Button>
        {!undone && update.undo && (
          <Button size="sm" disabled={revert.isPending} loading={revert.isPending} onClick={() => revert.mutate()}>
            {t("memoryCard.undo")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A proposal the agent made in the chat (`message.meta.proposalId`): the Propostas diff with Aceitar / Editar / Recusar. */
export function InlineProposal({ proposalId }: { proposalId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const proposals = useProposals(org.id);
  const decide = useDecideProposal(org.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const p = proposals.data?.find((x) => x.id === proposalId);
  if (!p) return null;
  const name = dir.agentById.get(p.agentId)?.name ?? t("channel.unknownAgent");
  const target =
    p.target.type === "org_context"
      ? t("proposals.targetContext", { org: org.name })
      : t("proposals.targetInstructions", agentGrammar(t, dir.agentById.get(p.target.agentId)?.name ?? name));
  const text = draft ?? p.after;
  const pending = p.status === "pending" && !p.stale;
  const onError = (e: unknown) =>
    toast.show(
      e instanceof Error && "status" in e && e.status === 409 ? t("proposals.staleError") : t("common.unknownError"),
      "error",
    );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ac-approval" role="group" aria-label={t("inlineProposal.group", { name })}>
      <div className="ac-approval__head">
        <span className="ac-approval__who">
          <Trans i18nKey="proposals.proposes" values={{ agent: name, target }} components={{ b: <b /> }} />
        </span>
        {p.stale ? (
          <Chip icon="close">{t("proposals.stale")}</Chip>
        ) : p.status === "pending" ? (
          <Chip icon="waiting" tone="waiting">
            {p.canDecide ? t("approval.waitingYou") : t("proposals.waitingAdmin")}
          </Chip>
        ) : p.status === "accepted" ? (
          <Chip icon="check" tone="done">
            {t("proposals.accepted")}
          </Chip>
        ) : (
          <Chip icon="close">{t("proposals.refused")}</Chip>
        )}
      </div>
      <p className="ac-approval__title">{p.title}</p>
      {editing && pending ? (
        <Field label={t("proposals.finalText")} id={`inline-prop-${p.id}`} help={t("proposals.finalHelp")}>
          <Textarea rows={6} value={text} onChange={(e) => setDraft(e.target.value)} />
        </Field>
      ) : (
        <Diff
          aria-label={t("proposals.changeLabel")}
          addedLabel={t("proposals.added")}
          removedLabel={t("proposals.removed")}
          lines={diffLines(p.before.split("\n"), text.split("\n"))}
        />
      )}
      <div className="ac-approval__actions">
        {pending && p.canDecide && (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={decide.isPending || !text.trim()}
              onClick={() =>
                decide.mutate(
                  { id: p.id, decision: "accept", text: draft !== null && draft !== p.after ? draft : undefined },
                  { onError },
                )
              }
            >
              {draft !== null && draft !== p.after ? t("proposals.acceptEdited") : t("proposals.accept")}
            </Button>
            <Button size="sm" onClick={() => setEditing((v) => !v)}>
              {editing ? t("proposals.viewDiff") : t("inlineProposal.edit")}
            </Button>
            <Button
              size="sm"
              disabled={decide.isPending}
              loading={decide.isPending && decide.variables?.decision === "refuse"}
              onClick={() => decide.mutate({ id: p.id, decision: "refuse" }, { onError })}
            >
              {t("proposals.refuse")}
            </Button>
          </>
        )}
        <Button asChild variant="ghost" size="sm">
          <Link to="/org/$orgId/proposals" params={{ orgId: org.id }} search={{ agent: p.agentId }}>
            {t("inlineProposal.open")}
          </Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * An agent's question (`ask_user`): neutral card in the thread with the
 * choices as buttons, or "Responder" to answer in the composer.
 */
export function QuestionCard({ question }: { question: AgentQuestion }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const live = useLiveStore();
  const actions = useChannelActions();
  const current = useLive((s) => s.questions[question.id]) ?? question;
  const [error, setError] = useState<string | null>(null);
  const answer = useMutation({
    mutationFn: (choice: string) => api.questions.answer(org.id, question.id, { choice }),
    // Errors are explained on the card.
    meta: { silent: true },
    onMutate: () => setError(null),
    onSuccess: (res, choice) => live.answered({ ...res, answer: res.answer ?? choice }),
    onError: (err) =>
      setError((err as { status?: number }).status === 409 ? t("question.alreadyAnswered") : t("question.failed")),
  });
  const agent = dir.agentById.get(question.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const done = current.status === "answered";
  const who = current.answeredByUserId === me.user.id ? null : dir.memberById.get(current.answeredByUserId ?? "")?.name;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      className={done ? "ac-approval ac-approval--done" : "ac-approval"}
      role="group"
      aria-label={t("question.group", { agent: name })}
    >
      {!done && <CardSky color={colorOf(agent)} />}
      <div className="ac-approval__head">
        <span className="ac-approval__who">
          <Trans i18nKey="question.asks" values={{ agent: name }} components={{ b: <b /> }} />
        </span>
        {done ? (
          <Chip icon="check" tone="done">
            {t("question.chipDone")}
          </Chip>
        ) : (
          <Chip icon="waiting" tone="waiting">
            {t("question.chip")}
          </Chip>
        )}
      </div>
      <p className="ac-approval__title">{current.text}</p>
      {done ? (
        <p className="small muted" style={{ margin: 0 }}>
          {who
            ? t("question.answered", { name: who, answer: current.answer ?? "" })
            : t("question.answeredByYou", { answer: current.answer ?? "" })}
        </p>
      ) : (
        <div className="ac-approval__actions">
          {(current.choices ?? []).map((choice) => (
            <Button
              key={choice}
              size="sm"
              disabled={answer.isPending}
              loading={answer.isPending && answer.variables === choice}
              onClick={() => answer.mutate(choice)}
            >
              {choice}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => actions?.focusComposer()}>
            {t("question.answer")}
          </Button>
        </div>
      )}
      {error && !done && (
        <p className="small muted" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
