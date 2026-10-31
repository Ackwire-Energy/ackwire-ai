import type { AgentQuestion, MemoryUpdate, Proposal, SecretRequest } from "@agenteschat/client";
import { keys, useCardProposals, useDecideProposal, useDecideProposals, useProposals } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  appLabel,
  cardHead,
  cardProposalIds,
  chosenRows,
  isOpen,
  proposalSections,
  proposalTarget,
  proposalTitle,
  proposerOf,
  rowStatus,
  staleCount,
} from "@agenteschat/client/lib/proposals";
import { MAX_SECRET_BYTES, sealSecret, secretAad } from "@agenteschat/client/lib/secret-box";
import { Button, Chip, Diff, diffLines, Field, Icon, Input, Switch, Textarea } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useLive, useLiveStore } from "@/realtime/context";
import { AgentAvatar } from "./AgentAvatar";
import { useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";
import { CardSky, colorOf } from "./Sky";
import "./proposals.css";

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
  if (update.action === "proposed") {
    const ids = cardProposalIds(update);
    if (ids.length > 1) return <ProposalGroup proposalIds={ids} />;
    return ids[0] ? <InlineProposal proposalId={ids[0]} /> : null;
  }
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

/** What a role or access proposal changes: "Papel: Dev → Revisora", or a chip per app turned on or off. */
export function SettingChange({ p }: { p: Proposal }) {
  const { t } = useTranslation();
  if (p.target.type === "agent_role")
    return <span className="proposal-change">{t("proposals.roleLine", { from: p.before, to: p.after })}</span>;
  return (
    <span className="proposal-change proposal-change--apps">
      {(p.access ?? []).map((l) => (
        <Chip key={l.id} icon={l.on ? "plus" : "dash"}>
          {t(l.on ? "proposals.accessOn" : "proposals.accessOff", { app: appLabel(t, l) })}
        </Chip>
      ))}
    </span>
  );
}

export const isText = (p: Proposal) => p.target.type === "agent_instructions" || p.target.type === "org_context";

/**
 * A proposal the agent made in the chat (`message.meta.proposalId`, or a card of one): the Propostas diff with
 * Aceitar / Editar / Recusar; a role or an app is taken as proposed, so it has no Editar.
 */
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
  const agentName = (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");
  const name = agentName(proposerOf(p));
  const target = proposalTarget(t, p, agentName, org.name);
  const text = draft ?? p.after;
  const pending = p.status === "pending" && !p.stale;
  const onError = (e: unknown) =>
    toast.show(
      e instanceof Error && "status" in e && e.status === 409
        ? t(isText(p) ? "proposals.staleError" : "proposals.staleErrorAgent")
        : t("common.unknownError"),
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
            {rowStatus(t, p) ?? t("approval.waitingYou")}
          </Chip>
        ) : p.status === "accepted" ? (
          <Chip icon="check" tone="done">
            {t("proposals.accepted")}
          </Chip>
        ) : (
          <Chip icon="close">{t("proposals.refused")}</Chip>
        )}
      </div>
      <p className="ac-approval__title">{proposalTitle(t, p, org.name, agentName)}</p>
      {!isText(p) ? (
        <SettingChange p={p} />
      ) : editing && pending ? (
        <Field label={t("proposals.finalText")} id={`inline-prop-${p.id}`}>
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
      <div className="ac-approval__actions ac-acts">
        {pending && p.canDecide && (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={decide.isPending || (isText(p) && !text.trim())}
              onClick={() =>
                decide.mutate(
                  { id: p.id, decision: "accept", text: draft !== null && draft !== p.after ? draft : undefined },
                  { onError },
                )
              }
            >
              {draft !== null && draft !== p.after ? t("proposals.acceptEdited") : t("proposals.accept")}
            </Button>
            {isText(p) && (
              <Button size="sm" onClick={() => setEditing((v) => !v)}>
                {editing ? t("proposals.viewDiff") : t("inlineProposal.edit")}
              </Button>
            )}
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
        <ProposalsLink agentId={p.agentId} />
      </div>
    </div>
  );
}

function ProposalsLink({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/org/$orgId/proposals" params={{ orgId: org.id }} search={{ agent: agentId }}>
        {t("inlineProposal.open")}
      </Link>
    </Button>
  );
}

/**
 * One change proposed for several agents (or several changes for one): each change shown once, then a row per
 * agent and kind of change with its switch, and "Aceitar para todos" / "Aceitar para N" and Recusar on the rows
 * the viewer may decide and left on. Each row applies on its own, so one that went stale never stops the rest.
 */
export function ProposalGroup({ proposalIds }: { proposalIds: string[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const rows = useCardProposals(org.id, proposalIds);
  const decide = useDecideProposals(org.id);
  const toast = useToast();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [first] = rows;
  if (!first) return null;
  const agentName = (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");
  const proposer = agentName(proposerOf(first));
  const head = cardHead(t, rows, proposer, agentName, org.name);
  const agents = new Set(rows.map((p) => p.agentId)).size;
  const { chosen, all } = chosenRows(rows, off);
  const decides = rows.some((p) => isOpen(p) && p.canDecide);
  const toggle = (id: string, on: boolean) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  const run = (decision: "accept" | "refuse") =>
    decide.mutate(
      { ids: chosen.map((p) => p.id), decision },
      {
        onSuccess: (failed) => {
          const stale = staleCount(failed);
          const agentRows = failed.some((f) => rows.find((p) => p.id === f.id && !isText(p)));
          if (stale > 0)
            toast.show(t(agentRows ? "proposals.staleSomeAgent" : "proposals.staleSome", { count: stale }), "error");
          if (failed.length > stale) toast.show(t("common.unknownError"), "error");
        },
      },
    );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      className="ac-approval"
      role="group"
      aria-label={t("inlineProposal.groupMany", { name: proposer, count: agents })}
    >
      <div className="ac-approval__head">
        <span className="ac-approval__who">
          <Trans i18nKey={head.key} values={head.values} components={{ b: <b /> }} />
        </span>
        {decides && (
          <Chip icon="waiting" tone="waiting">
            {t("approval.waitingYou")}
          </Chip>
        )}
      </div>
      {proposalSections(rows).map((section) => (
        <div key={section.rows[0]?.id} className="proposal-section">
          {section.kind === "text" && section.lines.length > 0 && (
            <Diff
              aria-label={t("proposals.changeLabel")}
              addedLabel={t("proposals.added")}
              removedLabel={t("proposals.removed")}
              lines={section.lines}
            />
          )}
          <ul className="proposal-rows">
            {section.rows.map((p) => {
              const name = p.target.type === "org_context" ? org.name : agentName(p.agentId);
              const status = rowStatus(t, p);
              return (
                <li key={p.id} className="proposal-row">
                  {p.target.type === "org_context" ? (
                    <Icon name="layers" size={20} />
                  ) : (
                    <AgentAvatar agentId={p.agentId} size="sm" name={name} />
                  )}
                  <span className="proposal-row__what">
                    <span className="proposal-row__name">{name}</span>
                    {!isText(p) && <SettingChange p={p} />}
                  </span>
                  {status && <span className="proposal-row__status">{status}</span>}
                  {isOpen(p) && (
                    <Switch
                      checked={p.canDecide && !off.has(p.id)}
                      disabled={!p.canDecide || decide.isPending}
                      onCheckedChange={(on) => toggle(p.id, on)}
                      aria-label={t("proposals.include", { name })}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="ac-approval__actions ac-acts">
        {decides && (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={decide.isPending || chosen.length === 0}
              loading={decide.isPending && decide.variables?.decision === "accept"}
              onClick={() => run("accept")}
            >
              {all ? t("proposals.acceptAll") : t("proposals.acceptSome", { count: chosen.length })}
            </Button>
            <Button
              size="sm"
              disabled={decide.isPending || chosen.length === 0}
              loading={decide.isPending && decide.variables?.decision === "refuse"}
              onClick={() => run("refuse")}
            >
              {t("proposals.refuse")}
            </Button>
          </>
        )}
        <ProposalsLink agentId={first.agentId} />
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
        <div className="ac-approval__actions ac-acts">
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
  const pending = current.status === "pending" && new Date(current.expiresAt).getTime() > Date.now();
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
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      className={pending ? "ac-approval secret-card" : "ac-approval ac-approval--done secret-card"}
      role="group"
      aria-label={t("secret.group", { agent: agentName })}
    >
      {pending && <CardSky color={colorOf(agent)} />}
      <div className="ac-approval__head">
        <span className="ac-approval__who">
          {mine ? (
            <Trans i18nKey="secret.asks" values={{ agent: agentName }} components={{ b: <b /> }} />
          ) : (
            <Trans i18nKey="secret.asksPerson" values={{ agent: agentName, person }} components={{ b: <b /> }} />
          )}
        </span>
        {status ? (
          <Chip
            icon={current.status === "delivered" ? "check" : "close"}
            tone={current.status === "delivered" ? "done" : "neutral"}
          >
            {status.chip}
          </Chip>
        ) : (
          <Chip icon="lock" tone="waiting">
            {t("secret.chip")}
          </Chip>
        )}
      </div>
      <p className="ac-approval__title">
        <code>{current.name}</code> · {current.purpose}
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        {where}
      </p>
      {pending && mine && (
        <form
          className="secret-card__form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field
            label={t("secret.label", { name: current.name })}
            help={t("secret.private")}
            error={error ?? undefined}
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              data-1p-ignore
            />
          </Field>
          <div className="ac-approval__actions ac-acts">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon="lock"
              loading={deliver.isPending}
              disabled={decline.isPending}
            >
              {t("secret.send")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              loading={decline.isPending}
              disabled={deliver.isPending}
              onClick={() => decline.mutate()}
            >
              {t("secret.decline")}
            </Button>
            <span className="small muted">
              {t("secret.until", { time: formatTime(i18n.language, current.expiresAt) })}
            </span>
          </div>
        </form>
      )}
      {pending && !mine && (
        <p className="small muted" style={{ margin: 0 }}>
          {t("secret.waitingFor", { person })}
        </p>
      )}
      {status && (
        <p className="small muted" style={{ margin: 0 }}>
          {status.line}
        </p>
      )}
      {error && !pending && (
        <p className="small muted" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
