import type { UsageQueue, UsageQueueClosedRow } from "@agenteschat/client";
import { useCancelUsageQueue, useUsageQueue } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { closedNoteText } from "@agenteschat/client/lib/usage-pause";
import {
  usageQueueFacts,
  usageQueueLine,
  usageQueueMeta,
  usageQueueShared,
  usageQueueState,
  usageQueueTitle,
  usageQueueWhere,
  usageWaitingText,
} from "@agenteschat/client/lib/usage-queue";
import { Button, Chip, Dialog, DialogBody, DialogFooter, useNow } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { AnswerAnywayButton, DontRunButton, TextAction } from "@/components/UsagePauseCard";
import { useDirectory } from "@/hooks/useDirectory";
import { useAgentPresence } from "@/hooks/usePresence";
import { useToast } from "@/lib/toast";
import "./computer-queue.css";

/**
 * An agent's line of work waiting on its plan or budget (ADR 0118): what it picks up when the limit is back, one
 * conversation at a time in this order, what happened in each since, and "Don't run it" per row ("Don't run any" and
 * "Change its AI" for its owner and admins). A dialog over the page the person is on, opened from its waiting note,
 * its out-of-office line, its page and its owner's notice.
 */
export function SeeUsageQueue({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <TextAction onClick={() => setOpen(true)}>{t("queue.see")}</TextAction>
      {open && <UsageQueueDialog agentId={agentId} open={open} onOpenChange={setOpen} />}
    </>
  );
}

/** On the agent's page, out of office with conversations waiting: "Sem limite no plano · 7 conversas esperando". */
export function UsageQueueChip({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const line = useAgentPresence(agentId)?.line;
  const [open, setOpen] = useState(false);
  const kind = line?.kind === "out_of_plan" || line?.kind === "out_of_budget" ? line.kind : null;
  const count = kind ? (line?.count ?? 0) : 0;
  if (!kind || count === 0) return null;
  return (
    <>
      <button type="button" className="noai-chip" title={t("queue.see")} onClick={() => setOpen(true)}>
        <Chip icon="waiting" tone="waiting">
          {`${t(`presence.agent.${kind}`)} · ${usageWaitingText(t, count)}`}
        </Chip>
      </button>
      {open && <UsageQueueDialog agentId={agentId} open={open} onOpenChange={setOpen} />}
    </>
  );
}

export function UsageQueueDialog({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const q = useUsageQueue(org.id, agentId, open);
  const now = useNow(open ? 60_000 : false);
  const agent = dir.agentById.get(agentId)?.name ?? t("channel.unknownAgent");
  const queue = q.data;
  const waiting = queue ? queue.rows.length + queue.hidden : 0;
  const queued = queue ? queue.rows.filter((r) => r.state === "queued").length + queue.hidden : 0;
  const closed = queue?.closed ?? [];
  const leave = () => onOpenChange(false);
  // "Não rodar nenhuma?" asked in place takes the whole footer.
  const [asking, setAsking] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={queue && waiting > 0 ? usageQueueTitle(t, agent, queue) : agent}
      closeLabel={t("common.close")}
      width={440}
      className="cq-dialog"
      subtitle={queue && waiting > 0 ? usageQueueLine(t, i18n.language, queue, new Date(now)) : undefined}
    >
      <DialogBody>
        {queue ? (
          <div className="cq">
            {waiting > 0 ? (
              <WaitingRows queue={queue} agent={agent} now={now} titled={closed.length > 0} onLeave={leave} />
            ) : (
              closed.length === 0 && <p className="cq__empty">{t("usageQueue.empty")}</p>
            )}
            {closed.length > 0 && (
              <SkippedRows rows={closed} agentId={agentId} agent={agent} now={now} onLeave={leave} />
            )}
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <LoadingList count={3} />
        )}
      </DialogBody>
      {queue?.mayStopAll && waiting > 0 && (
        <DialogFooter
          bar
          note={
            asking ? undefined : (
              <Link
                className="cq-link"
                to="/org/$orgId/agents/$agentId"
                params={{ orgId: org.id, agentId }}
                search={{ tab: "settings", sec: "brain" }}
                onClick={leave}
              >
                {t("usageQueue.switchAi", agentGrammar(agent))}
              </Link>
            )
          }
        >
          {queued > 0 && <StopAll agentId={agentId} agent={agent} count={queued} asking={asking} onAsk={setAsking} />}
        </DialogFooter>
      )}
    </Dialog>
  );
}

/** "Ver conversa": the conversation at the message, with the dialog closed. */
function useOpenConversation(onLeave: () => void) {
  const { org } = useOrg();
  const navigate = useNavigate();
  return (row: { channelId: string; threadId: string | null; messageId: string }) => {
    onLeave();
    void (row.threadId
      ? navigate({
          to: "/org/$orgId/threads/$threadId",
          params: { orgId: org.id, threadId: row.threadId },
          search: { m: row.messageId },
        })
      : navigate({
          to: "/org/$orgId/c/$channelId",
          params: { orgId: org.id, channelId: row.channelId },
          search: { m: row.messageId },
        }));
  };
}

/** A row's face: the first person who asked (who waits on it), or the agent itself for a routine or long work. */
function RowFace({
  agentId,
  agent,
  askers,
  answering,
}: {
  agentId: string;
  agent: string;
  askers: string[];
  answering?: boolean;
}) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const asker = askers[0];
  return asker ? (
    <PersonAvatar id={asker} name={dir.memberById.get(asker)?.name ?? ""} size="xs" />
  ) : (
    <AgentAvatar agentId={agentId} name={agent} size="xs" state={answering ? "thinking" : "idle"} />
  );
}

function WaitingRows({
  queue,
  agent,
  now,
  titled,
  onLeave,
}: {
  queue: UsageQueue;
  agent: string;
  now: number;
  /** The skipped section follows, so this one is titled too. */
  titled: boolean;
  onLeave: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const openConversation = useOpenConversation(onLeave);
  const person = (id: string) =>
    id === me.user.id ? t("common.you") : (dir.memberById.get(id)?.name ?? t("channel.unknownPerson"));
  const shared = usageQueueShared(
    t,
    agent,
    queue.sharedWith.flatMap((id) => dir.agentById.get(id)?.name ?? []),
  );
  return (
    <section className="cq__group">
      {titled && <h3 className="cq__title">{t("usageQueue.toResume")}</h3>}
      {shared && <p className="cq__rule">{shared}</p>}
      {queue.rows.length > 0 && (
        <ol className="cq__rows">
          {queue.rows.map((row) => (
            <li key={row.runId} className="cq__row" data-mine={row.askers.includes(me.user.id) || undefined}>
              <RowFace
                agentId={queue.agentId}
                agent={agent}
                askers={row.askers}
                answering={row.state === "answering"}
              />
              <span className="cq__text">
                <span className="cq__l1">
                  <b>{usageQueueWhere(t, row, me.user.id, person)}</b>
                  <span className="cq__time" data-now={row.state === "answering" || undefined}>
                    {usageQueueState(t, row)}
                  </span>
                </span>
                <span className="cq__l2">{usageQueueMeta(t, i18n.language, row, person, new Date(now))}</span>
                <span className="cq__l2">{usageQueueFacts(t, row, me.user.name)}</span>
                <span className="cq__acts">
                  {row.state === "queued" && row.mayStop && <DontRunButton runId={row.runId} may />}
                  <TextAction onClick={() => openConversation(row)}>{t("usageQueue.seeConversation")}</TextAction>
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {queue.hidden > 0 && <p className="cq__rule">{t("usageQueue.hidden", { count: queue.hidden })}</p>}
    </section>
  );
}

/**
 * The catch-ups it skipped in the last day as already handled (ADR 0136): why, "Responder mesmo assim" for who may,
 * and "Ver conversa". A wrong skip is one look and one click away.
 */
function SkippedRows({
  rows,
  agentId,
  agent,
  now,
  onLeave,
}: {
  rows: UsageQueueClosedRow[];
  agentId: string;
  agent: string;
  now: number;
  onLeave: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const openConversation = useOpenConversation(onLeave);
  return (
    <section className="cq__group">
      <h3 className="cq__title">{t("usageQueue.closedTitle", { count: rows.length })}</h3>
      <p className="cq__rule">
        {t(rows.some((r) => r.mayAnswer && !r.continuedRunId) ? "usageQueue.closedLine" : "usageQueue.closedWhy", {
          agent,
        })}
      </p>
      <ol className="cq__rows">
        {rows.map((row) => (
          <li key={row.runId} className="cq__row" data-mine={row.closed.askers.includes(me.user.id) || undefined}>
            <RowFace agentId={agentId} agent={agent} askers={row.closed.askers} />
            <span className="cq__text">
              <span className="cq__l1">
                <b>
                  {row.channelKind === "dm"
                    ? t("usageQueue.yourDm")
                    : row.threadId
                      ? t("usageQueue.thread", { channel: row.channelName ?? "" })
                      : `#${row.channelName ?? ""}`}
                </b>
                <span className="cq__time">{relativeTime(t, i18n.language, row.closed.at, new Date(now))}</span>
              </span>
              <span className="cq__l2">{closedNoteText(t, row.closed)}</span>
              {row.continuedRunId && <span className="cq__l2">{t("usageQueue.answeredAnyway")}</span>}
              <span className="cq__acts">
                {row.mayAnswer && !row.continuedRunId && (
                  <AnswerAnywayButton runId={row.runId} agentId={agentId} closed={row.closed} />
                )}
                <TextAction onClick={() => openConversation(row)}>{t("usageQueue.seeConversation")}</TextAction>
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** "Don't run any", asked once in place: "Don't run these 7?" with "Yes, don't run" and "Keep". */
function StopAll({
  agentId,
  agent,
  count,
  asking,
  onAsk: setAsking,
}: {
  agentId: string;
  agent: string;
  count: number;
  asking: boolean;
  onAsk: (asking: boolean) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const stop = useCancelUsageQueue(org.id, agentId);
  if (!asking) return <Button onClick={() => setAsking(true)}>{t("usageQueue.dontRunAll")}</Button>;
  return (
    <fieldset className="cq-confirm" aria-label={t("usageQueue.confirmAll", { count })}>
      <span className="cq-confirm__ask">{t("usageQueue.confirmAll", { count })}</span>
      <Button variant="ghost" onClick={() => setAsking(false)}>
        {t("usageQueue.keep")}
      </Button>
      <Button
        variant="danger"
        loading={stop.isPending}
        onClick={() =>
          stop.mutate(undefined, {
            onSuccess: (r) => {
              setAsking(false);
              toast.show(t("usageQueue.canceledAll", { count: r.canceled, agent }));
            },
            onError: (error) => toast.show(errorText(t, error), "error"),
          })
        }
      >
        {t("usageQueue.yesDontRun")}
      </Button>
    </fieldset>
  );
}
