import type { UsageQueue, UsageQueueRow } from "@agenteschat/client";
import { useApi, useCancelUsageQueue, useUsageQueue } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  usageQueueFacts,
  usageQueueLine,
  usageQueueMeta,
  usageQueueShared,
  usageQueueState,
  usageQueueTitle,
  usageQueueWhere,
} from "@agenteschat/client/lib/usage-queue";
import { Button, Dialog, DialogBody, DialogFooter, useNow } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./computer-queue.css";

/**
 * An agent's line of work waiting on its plan or budget (ADR 0118): what it picks up when the limit is back, one
 * conversation at a time in this order, what happened in each since, and "Don't run it" per row ("Don't run any" for
 * its owner and admins). Opened from its waiting note and from its out-of-office line.
 */
export function SeeUsageQueue({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="cq-link" onClick={() => setOpen(true)}>
        {t("queue.see")}
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
  const empty = queue && queue.rows.length === 0 && queue.hidden === 0;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={queue && !empty ? usageQueueTitle(t, agent, queue) : agent}
      closeLabel={t("common.close")}
      width={440}
      className="cq-dialog"
      subtitle={queue && !empty ? usageQueueLine(t, i18n.language, queue, new Date(now)) : undefined}
    >
      <DialogBody>
        {queue ? (
          empty ? (
            <p className="cq__empty">{t("usageQueue.empty")}</p>
          ) : (
            <UsageQueueRows queue={queue} agent={agent} now={now} />
          )
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <LoadingList count={3} />
        )}
      </DialogBody>
      {queue?.mayStopAll && queue.rows.some((r) => r.state === "queued") && (
        <DialogFooter>
          <StopAll
            agentId={agentId}
            agent={agent}
            count={queue.rows.filter((r) => r.state === "queued").length + queue.hidden}
          />
        </DialogFooter>
      )}
    </Dialog>
  );
}

function UsageQueueRows({ queue, agent, now }: { queue: UsageQueue; agent: string; now: number }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const person = (id: string) =>
    id === me.user.id ? t("common.you") : (dir.memberById.get(id)?.name ?? t("channel.unknownPerson"));
  const shared = usageQueueShared(
    t,
    agent,
    queue.sharedWith.flatMap((id) => dir.agentById.get(id)?.name ?? []),
  );
  return (
    <div className="cq">
      <section className="cq__group">
        {shared && <p className="cq__rule">{shared}</p>}
        <ol className="cq__rows">
          {queue.rows.map((row) => (
            <li key={row.runId} className="cq__row" data-mine={row.askers.includes(me.user.id) || undefined}>
              <AgentAvatar
                agentId={queue.agentId}
                name={agent}
                size="xs"
                state={row.state === "answering" ? "thinking" : "idle"}
              />
              <span className="cq__text">
                <span className="cq__l1">
                  <b>{usageQueueWhere(t, row, me.user.id, person)}</b>
                  <span className="cq__time" data-now={row.state === "answering" || undefined}>
                    {usageQueueState(t, row)}
                  </span>
                </span>
                <span className="cq__l2">{usageQueueMeta(t, i18n.language, row, person, new Date(now))}</span>
                <span className="cq__l2">{usageQueueFacts(t, row)}</span>
                {row.state === "queued" && <RowStop row={row} />}
              </span>
            </li>
          ))}
        </ol>
        {queue.hidden > 0 && <p className="cq__rule">{t("usageQueue.hidden", { count: queue.hidden })}</p>}
      </section>
    </div>
  );
}

/** "Don't run it" on one row: who asked, the agent's owner or an admin; anyone else sees it greyed with why. */
function RowStop({ row }: { row: UsageQueueRow }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="stop"
      className="cq-stop"
      loading={pending}
      disabled={!row.mayStop}
      title={t(row.mayStop ? "usageCard.dontRunHint" : "usageCard.dontRunForbidden")}
      onClick={async () => {
        setPending(true);
        try {
          await api.agents.cancelRun(org.id, row.runId);
          toast.show(t("usageCard.canceled"));
        } catch (error) {
          toast.show(errorText(t, error), "error");
        } finally {
          setPending(false);
        }
      }}
    >
      {t("usageCard.dontRun")}
    </Button>
  );
}

/** "Don't run any", asked once in place: "Don't run these 7?" with "Yes, don't run" and "Keep". */
function StopAll({ agentId, agent, count }: { agentId: string; agent: string; count: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const stop = useCancelUsageQueue(org.id, agentId);
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button icon="stop" onClick={() => setAsking(true)}>
        {t("usageQueue.dontRunAll")}
      </Button>
    );
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
