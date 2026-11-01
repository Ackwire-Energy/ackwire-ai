import type { AgentQuestion, MemoryUpdate, Proposal, SecretRequest } from "@agenteschat/client";
import { keys, useCardProposals, useDecideProposal, useDecideProposals } from "@agenteschat/client";
import { formatTime, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  appLabel,
  cardHead,
  cardOutcome,
  cardProposalIds,
  chosenRows,
  firstChange,
  isOpen,
  proposalSections,
  proposalTarget,
  proposalTitle,
  proposerOf,
  rowStatus,
  staleCount,
} from "@agenteschat/client/lib/proposals";
import { MAX_SECRET_BYTES, sealSecret, secretAad } from "@agenteschat/client/lib/secret-box";
import { Button, Chip, Diff, diffLines, Field, Icon, Input, MessageText, Switch, Textarea } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useDirectory } from "@/hooks/useDirectory";
import { TYPED_VALUES } from "@/i18n";
import { useToast } from "@/lib/toast";
import { useLive, useLiveStore } from "@/realtime/context";
import { AgentAvatar } from "./AgentAvatar";
import { SiteIcon } from "./browser/SiteIcon";
import { useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";
import { RequestCard, RequestDone, RequestTile, useExpired } from "./RequestCard";
import "./proposals.css";

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
  const [p] = useCardProposals(org.id, [proposalId]);
  const decide = useDecideProposal(org.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
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
  const edited = draft !== null && draft !== p.after;
  const diff = (
    <Diff
      aria-label={t("proposals.changeLabel")}
      addedLabel={t("proposals.added")}
      removedLabel={t("proposals.removed")}
      lines={diffLines(p.before.split("\n"), text.split("\n"))}
    />
  );

  // Waiting: a request card, the change behind "Ver a mudança" (a text is edited there before accepting).
  if (pending) {
    const before = new Set(p.before.split("\n"));
    const firstNew = isText(p)
      ? p.after
          .split("\n")
          .find((line) => line.trim() && !before.has(line))
          ?.trim()
      : undefined;
    return (
      <RequestCard
        id={p.id}
        kind="proposal"
        agent={dir.anyAgent(proposerOf(p))}
        label={t("inlineProposal.group", { name })}
        mine={p.canDecide}
        waitingFor={rowStatus(t, p) ?? undefined}
        lead={proposalTitle(t, p, org.name, agentName)}
        object={{
          logo: (
            <RequestTile>
              <Icon name={p.target.type === "agent_access" ? "layers" : "file"} size={16} />
            </RequestTile>
          ),
          title: target,
          detail: p.target.type === "agent_role" ? t("proposals.roleLine", { from: p.before, to: p.after }) : firstNew,
          ...(isText(p) ? { more: t("ask.seeChange") } : {}),
        }}
        details={
          isText(p) ? (
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
                <ProposalsLink agentId={p.agentId} />
              </div>
            </>
          ) : undefined
        }
        // A new role reads in the well; the apps are chips, under it. Neither has anything to open.
        body={
          p.target.type === "agent_access" ? (
            <div className="rq__field">
              <SettingChange p={p} />
            </div>
          ) : undefined
        }
        actions={
          p.canDecide ? (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={decide.isPending || (isText(p) && !text.trim())}
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

  // Decided, or overtaken by a newer text: one line, the change as it was behind "Ver a mudança".
  return (
    <ProposalDone
      label={t("inlineProposal.group", { name })}
      what={<b>{proposalTitle(t, p, org.name, agentName)}</b>}
      rows={[p]}
    >
      {isText(p) ? diff : <SettingChange p={p} />}
      <div className="ac-acts">
        <ProposalsLink agentId={p.agentId} />
      </div>
    </ProposalDone>
  );
}

/** A decided proposal's line: what it was, how it ended and when the last row was decided; the rest when asked for. */
function ProposalDone({
  label,
  what,
  rows,
  children,
}: {
  label: string;
  what: ReactNode;
  rows: Proposal[];
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const outcome = cardOutcome(t, rows);
  // A row overtaken by a newer text was never decided.
  const at = rows
    .flatMap((p) => p.decidedAt ?? [])
    .sort()
    .at(-1);
  return (
    <RequestDone done={outcome.accepted} label={label} more={{ label: t("ask.seeChange"), content: children }}>
      {outcome.label}: {what}
      {at && ` · ${whenAt(t, i18n.language, at)}`}
    </RequestDone>
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
        onSuccess: ({ failed }) => {
          const stale = staleCount(failed);
          const agentRows = failed.some((f) => rows.find((p) => p.id === f.id && !isText(p)));
          if (stale > 0)
            toast.show(t(agentRows ? "proposals.staleSomeAgent" : "proposals.staleSome", { count: stale }), "error");
          if (failed.length > stale) toast.show(t("common.unknownError"), "error");
        },
      },
    );

  const label = t("inlineProposal.groupMany", { name: proposer, count: agents });
  const who = <Trans i18nKey={head.key} values={head.values} components={{ b: <b /> }} {...TYPED_VALUES} />;
  const rowList = (list: Proposal[]) => (
    <ul className="proposal-rows">
      {list.map((p) => {
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
  );
  const groups = proposalSections(rows);

  // Waiting: a request card like every other, the rows and their switches above its decision.
  if (rows.some(isOpen)) {
    const tt = t as unknown as (key: string, options: Record<string, unknown>) => string;
    const texts = groups.flatMap((g) => (g.kind === "text" && g.lines.length > 0 ? [g] : []));
    const firstLine = firstChange(texts[0]?.lines);
    return (
      <RequestCard
        id={first.id}
        kind="proposal"
        agent={dir.anyAgent(proposerOf(first))}
        label={label}
        mine={decides}
        lead={who}
        object={
          firstLine
            ? {
                logo: (
                  <RequestTile>
                    <Icon name="file" size={16} />
                  </RequestTile>
                ),
                title: firstLine.text,
                more: t("ask.seeChange"),
              }
            : undefined
        }
        details={
          texts.length > 0 ? (
            <>
              {texts.map((g) => (
                <Diff
                  key={g.rows[0]?.id}
                  aria-label={t("proposals.changeLabel")}
                  addedLabel={t("proposals.added")}
                  removedLabel={t("proposals.removed")}
                  lines={g.lines}
                />
              ))}
              <div className="ac-acts">
                <ProposalsLink agentId={first.agentId} />
              </div>
            </>
          ) : undefined
        }
        body={rowList(groups.flatMap((g) => g.rows))}
        actions={
          decides ? (
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
          ) : undefined
        }
        what={tt(head.key, head.values).replace(/<\/?b>/g, "")}
      />
    );
  }

  // Decided, or overtaken by a newer text.
  return (
    <ProposalDone label={label} what={who} rows={rows}>
      {groups.map((section) => (
        <div key={section.rows[0]?.id} className="proposal-section">
          {section.kind === "text" && section.lines.length > 0 && (
            <Diff
              aria-label={t("proposals.changeLabel")}
              addedLabel={t("proposals.added")}
              removedLabel={t("proposals.removed")}
              lines={section.lines}
            />
          )}
          {rowList(section.rows)}
        </div>
      ))}
      <div className="ac-acts">
        <ProposalsLink agentId={first.agentId} />
      </div>
    </ProposalDone>
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
  // Answered: the question stays in the open as the agent's words; one line says who answered and what.
  const answerText = current.answer ?? "";
  return (
    <>
      <MessageText>{current.text}</MessageText>
      <RequestDone done label={t("question.group", { agent: name })}>
        {who ? (
          <Trans
            i18nKey="question.answered"
            values={{ name: who, answer: answerText }}
            components={{ b: <b /> }}
            {...TYPED_VALUES}
          />
        ) : (
          <Trans
            i18nKey="question.answeredByYou"
            values={{ answer: answerText }}
            components={{ b: <b /> }}
            {...TYPED_VALUES}
          />
        )}
      </RequestDone>
    </>
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
  // Closed: one line, how it ended (its message already names the secret).
  const closed: Record<Exclude<SecretRequest["status"], "pending">, string> = {
    delivered: current.deliveredAt
      ? mine
        ? t("secret.deliveredByYou", { time: formatTime(i18n.language, current.deliveredAt) })
        : t("secret.delivered", { person, time: formatTime(i18n.language, current.deliveredAt) })
      : t("secret.chipDone"),
    declined: t("secret.declined"),
    expired: t("secret.expired"),
    canceled: t("secret.canceled"),
  };
  return (
    <>
      <RequestDone done={current.status === "delivered"} label={t("secret.group", { agent: agentName })}>
        {closed[current.status === "pending" ? "expired" : current.status]}
      </RequestDone>
      {error && (
        <p className="rq__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
