import type { AgentQuestion, MemoryUpdate, SecretRequest } from "@agenteschat/client";
import { keys, useDecideProposal, useProposals } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { MAX_SECRET_BYTES, sealSecret, secretAad } from "@agenteschat/client/lib/secret-box";
import { Button, Chip, Diff, diffLines, Field, Icon, Input, Textarea } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useDirectory } from "@/hooks/useDirectory";
import { TYPED_VALUES } from "@/i18n";
import { useToast } from "@/lib/toast";
import { useLive, useLiveStore } from "@/realtime/context";
import { SiteIcon } from "./browser/SiteIcon";
import { useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";
import { RequestCard, RequestTile, useExpired } from "./RequestCard";

/** The host of a site the request names (`https://host`), or null. */
const hostOf = (site: string | null | undefined) => {
  if (!site) return null;
  try {
    return new URL(site).host || null;
  } catch {
    return null;
  }
};

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
  const name = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
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
      <div className="ac-approval__actions ac-acts">
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
  const name = dir.anyAgent(p.agentId)?.name ?? t("channel.unknownAgent");
  const target =
    p.target.type === "org_context"
      ? t("proposals.targetContext", { org: org.name })
      : t("proposals.targetInstructions", agentGrammar(t, dir.anyAgent(p.target.agentId)?.name ?? name));
  const text = draft ?? p.after;
  const pending = p.status === "pending" && !p.stale;
  const onError = (e: unknown) =>
    toast.show(
      e instanceof Error && "status" in e && e.status === 409 ? t("proposals.staleError") : t("common.unknownError"),
      "error",
    );
  const edited = draft !== null && draft !== p.after;
  const diff = (
    <Diff
      aria-label={t("proposals.changeLabel")}
      addedLabel={t("proposals.added")}
      removedLabel={t("proposals.removed")}
      lines={diffLines(p.before.split("\n"), text.split("\n"))}
    />
  );

  // Waiting: a request card, the change behind "Ver a mudança" (edited there before accepting).
  if (pending) {
    const before = new Set(p.before.split("\n"));
    const firstNew = p.after
      .split("\n")
      .find((line) => line.trim() && !before.has(line))
      ?.trim();
    return (
      <RequestCard
        id={p.id}
        kind="proposal"
        agent={dir.anyAgent(p.agentId)}
        label={t("inlineProposal.group", { name })}
        mine={p.canDecide}
        waitingFor={t("proposals.waitingAdmin")}
        lead={p.title}
        object={{
          logo: (
            <RequestTile>
              <Icon name="file" size={16} />
            </RequestTile>
          ),
          title: target,
          detail: firstNew,
          more: t("ask.seeChange"),
        }}
        details={
          <>
            {editing ? (
              <Field label={t("proposals.finalText")} id={`inline-prop-${p.id}`}>
                <Textarea rows={6} value={text} onChange={(e) => setDraft(e.target.value)} />
              </Field>
            ) : (
              diff
            )}
            <div className="ac-acts">
              {p.canDecide && (
                <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>
                  {editing ? t("proposals.viewDiff") : t("inlineProposal.edit")}
                </Button>
              )}
              <Button asChild variant="ghost" size="sm">
                <Link to="/org/$orgId/proposals" params={{ orgId: org.id }} search={{ agent: p.agentId }}>
                  {t("inlineProposal.open")}
                </Link>
              </Button>
            </div>
          </>
        }
        actions={
          p.canDecide ? (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={decide.isPending || !text.trim()}
                loading={decide.isPending && decide.variables?.decision === "accept"}
                onClick={() =>
                  decide.mutate(
                    { id: p.id, decision: "accept", text: edited ? (draft ?? undefined) : undefined },
                    { onError },
                  )
                }
              >
                {edited ? t("proposals.acceptEdited") : t("proposals.accept")}
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
          ) : undefined
        }
        what={target}
      />
    );
  }

  // Decided, or overtaken by a newer text: the settled card with the change as it was.
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ac-approval" role="group" aria-label={t("inlineProposal.group", { name })}>
      <div className="ac-approval__head">
        <span className="ac-approval__who">
          <Trans
            i18nKey="proposals.proposes"
            values={{ agent: name, target }}
            components={{ b: <b /> }}
            {...TYPED_VALUES}
          />
        </span>
        {p.stale ? (
          <Chip icon="close">{t("proposals.stale")}</Chip>
        ) : p.status === "accepted" ? (
          <Chip icon="check" tone="done">
            {t("proposals.accepted")}
          </Chip>
        ) : (
          <Chip icon="close">{t("proposals.refused")}</Chip>
        )}
      </div>
      <p className="ac-approval__title">{p.title}</p>
      {diff}
      <div className="ac-approval__actions ac-acts">
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
  const agent = dir.anyAgent(question.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const done = current.status === "answered";
  const who = current.answeredByUserId === me.user.id ? null : dir.memberById.get(current.answeredByUserId ?? "")?.name;
  // Open: a request card, the choices in its footer and "Outra resposta" to write one in the composer.
  if (!done) {
    const choices = current.choices ?? [];
    return (
      <RequestCard
        id={question.id}
        kind="question"
        agent={agent}
        label={t("question.group", { agent: name })}
        mine
        lead={current.text}
        body={
          error ? (
            <p className="rq__error" role="alert">
              {error}
            </p>
          ) : undefined
        }
        actions={
          <>
            {choices.map((choice) => (
              <Button
                key={choice}
                size="sm"
                data-choice=""
                disabled={answer.isPending}
                loading={answer.isPending && answer.variables === choice}
                onClick={() => answer.mutate(choice)}
              >
                {choice}
              </Button>
            ))}
            <Button
              variant={choices.length > 0 ? "ghost" : "primary"}
              size="sm"
              onClick={() => actions?.focusComposer()}
            >
              {choices.length > 0 ? t("ask.otherAnswer") : t("question.answer")}
            </Button>
          </>
        }
        what={current.text}
      />
    );
  }
  // Answered: the settled card, who answered and what.
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ac-approval ac-approval--done" role="group" aria-label={t("question.group", { agent: name })}>
      <div className="ac-approval__head">
        <span className="ac-approval__who">
          <Trans i18nKey="question.asks" values={{ agent: name }} components={{ b: <b /> }} {...TYPED_VALUES} />
        </span>
        <Chip icon="check" tone="done">
          {t("question.chipDone")}
        </Chip>
      </div>
      <p className="ac-approval__title">{current.text}</p>
      <p className="small muted" style={{ margin: 0 }}>
        {who
          ? t("question.answered", { name: who, answer: current.answer ?? "" })
          : t("question.answeredByYou", { answer: current.answer ?? "" })}
      </p>
    </div>
  );
}

/**
 * An agent asks for a secret for its computer (`request_secret`, ADR 0027).
 * Only the person asked sees the field; the value is sealed here, in the
 * browser, to the key the computer made, so it never reaches our server, the
 * chat or the agent. Everyone else sees who was asked.
 */
export function SecretCard({ request }: { request: SecretRequest }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const live = useLiveStore();
  const current = useLive((s) => s.secrets[request.id]) ?? request;
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const agent = dir.anyAgent(request.agentId);
  const agentName = agent?.name ?? t("channel.unknownAgent");
  const mine = current.requestedForUserId === me.user.id;
  const person = dir.memberById.get(current.requestedForUserId)?.name ?? t("channel.unknownPerson");
  // Past its deadline it closes as expired, even before the server's event says so.
  const expired = useExpired(current.status === "pending" ? current.expiresAt : null);
  const pending = current.status === "pending" && !expired;
  const failed = (err: unknown) => {
    const status = (err as { status?: number }).status;
    setError(status === 409 ? t("secret.alreadyAnswered") : t("secret.failed"));
  };
  const deliver = useMutation({
    meta: { silent: true },
    mutationFn: async (text: string) => {
      if (!current.publicKey) throw Object.assign(new Error("closed"), { status: 409 });
      const aad = secretAad({ requestId: current.id, orgId: org.id, name: current.name, target: current.target });
      return api.secrets.deliver(org.id, current.id, await sealSecret(current.publicKey, text, aad));
    },
    onMutate: () => setError(null),
    onSuccess: (res) => {
      setValue("");
      live.secretAnswered(res);
    },
    onError: failed,
  });
  const decline = useMutation({
    meta: { silent: true },
    mutationFn: () => api.secrets.decline(org.id, current.id),
    onMutate: () => setError(null),
    onSuccess: (res) => live.secretAnswered(res),
    onError: failed,
  });
  const submit = () => {
    if (!value) return setError(t("secret.empty"));
    if (new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) return setError(t("secret.tooLarge"));
    deliver.mutate(value);
  };
  const closed: Record<Exclude<SecretRequest["status"], "pending">, { chip: string; line: string }> = {
    delivered: {
      chip: t("secret.chipDone"),
      line: current.deliveredAt
        ? mine
          ? t("secret.deliveredByYou", { time: formatTime(i18n.language, current.deliveredAt) })
          : t("secret.delivered", { person, time: formatTime(i18n.language, current.deliveredAt) })
        : t("secret.chipDone"),
    },
    declined: { chip: t("secret.chipDeclined"), line: t("secret.declined") },
    expired: { chip: t("secret.chipExpired"), line: t("secret.expired") },
    canceled: { chip: t("secret.chipCanceled"), line: t("secret.canceled") },
  };
  const status = pending ? null : closed[current.status === "pending" ? "expired" : current.status];
  const where =
    current.target.kind === "file"
      ? t("secret.targetFile", { path: current.target.path, agent: agentName })
      : t("secret.targetEnv", { name: current.name, agent: agentName });
  const until = t("secret.until", { time: formatTime(i18n.language, current.expiresAt) });
  // Waiting: a request card; only the person asked gets the field (the whole card is its form).
  if (pending) {
    const host = hostOf(current.site);
    return (
      <RequestCard
        id={current.id}
        kind="secret"
        agent={agent}
        label={t("secret.group", { agent: agentName })}
        mine={mine}
        waitingFor={t("ask.waitingFor", { name: person })}
        lead={current.purpose}
        object={{
          logo: <RequestTile>{host ? <SiteIcon host={host} /> : <Icon name="lock" size={16} />}</RequestTile>,
          title: current.name,
          detail: where,
        }}
        body={
          mine ? (
            <>
              <div className="rq__field">
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  placeholder={t("secret.label", { name: current.name })}
                  aria-label={t("secret.label", { name: current.name })}
                  invalid={Boolean(error)}
                  onChange={(e) => setValue(e.target.value)}
                  data-1p-ignore
                />
              </div>
              {error ? (
                <p className="rq__error" role="alert">
                  {error}
                </p>
              ) : (
                <p className="rq__note ac-iconline">
                  <Icon name="lock" size={14} />
                  <span>{t("secret.private")}</span>
                </p>
              )}
            </>
          ) : undefined
        }
        actions={
          mine ? (
            <>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={deliver.isPending}
                disabled={decline.isPending}
              >
                {t("secret.send")}
              </Button>
              <Button
                type="button"
                size="sm"
                loading={decline.isPending}
                disabled={deliver.isPending}
                onClick={() => decline.mutate()}
              >
                {t("secret.decline")}
              </Button>
            </>
          ) : undefined
        }
        end={until}
        what={current.name}
        onSubmit={mine ? submit : undefined}
      />
    );
  }
  // Closed: the settled card, how it ended.
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      className="ac-approval ac-approval--done secret-card"
      role="group"
      aria-label={t("secret.group", { agent: agentName })}
    >
      <div className="ac-approval__head">
        <span className="ac-approval__who">
          {mine ? (
            <Trans i18nKey="secret.asks" values={{ agent: agentName }} components={{ b: <b /> }} {...TYPED_VALUES} />
          ) : (
            <Trans
              i18nKey="secret.asksPerson"
              values={{ agent: agentName, person }}
              components={{ b: <b /> }}
              {...TYPED_VALUES}
            />
          )}
        </span>
        {status && (
          <Chip
            icon={current.status === "delivered" ? "check" : "close"}
            tone={current.status === "delivered" ? "done" : "neutral"}
          >
            {status.chip}
          </Chip>
        )}
      </div>
      <p className="ac-approval__title">
        <code>{current.name}</code> · {current.purpose}
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        {where}
      </p>
      {status && (
        <p className="small muted" style={{ margin: 0 }}>
          {status.line}
        </p>
      )}
      {error && (
        <p className="small muted" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
