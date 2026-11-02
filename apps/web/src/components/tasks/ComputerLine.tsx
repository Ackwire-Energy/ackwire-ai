import type { ComputerSummary, QueueTurn } from "@agenteschat/client";
import { useComputerQueue } from "@agenteschat/client";
import { queueWho } from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import { Button, Chip, Icon } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { StopTaskButton, useTaskStop } from "./TaskBits";
import "@/components/threads/threads.css";

/*
 * A computer's line (ADR 0127): the turns running on it now, then who waits for room, in the order they start
 * (people's first). Everyone in the workspace sees the same order; a turn says what it is for only to who sees its
 * conversation, else whose it is ("Pedido de uma pessoa"). No memory figure: computers don't report it live.
 */

/** "Cheio · 3 na fila" or "Tem espaço", and "1 trabalhando": a computer as the page lists it. */
export function computerLine(t: TFunction, c: ComputerSummary) {
  const room = c.inLine > 0 ? t("taskManager.queue.full", { count: c.inLine }) : t("taskManager.queue.room");
  return c.working > 0 ? `${room} · ${t("taskManager.working", { count: c.working })}` : room;
}

/**
 * The line's head and body, in a side panel (`ComputerLinePanel`) or in place of an agent's tasks in theirs, with
 * `onBack` to them. A turn the person can see opens its task (`onOpenTask`, the page's task panel).
 */
export function ComputerLine({
  machineId,
  name,
  onClose,
  onBack,
  onOpenTask,
}: {
  machineId: string;
  /** The computer's name until its line loads. */
  name?: string;
  onClose: () => void;
  /** Back to the agent's tasks ("Voltar para as tarefas"). */
  onBack?: () => void;
  onOpenTask?: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const queue = useComputerQueue(org.id, machineId);
  const now = useNow(30_000);
  const { stop, stopping } = useTaskStop();
  const data = queue.data;
  const ago = (since: string | null) => (since ? formatDuration(t, Math.max(0, now - Date.parse(since))) : null);
  return (
    <>
      <header className="channel__header thread-head thread-head--panel">
        {onBack && (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronLeft"
            aria-label={t("taskManager.queue.back")}
            title={t("taskManager.queue.back")}
            onClick={onBack}
          />
        )}
        <span className="thread-head__who tm-line__icon" aria-hidden="true">
          <Icon name="computer" size={18} />
        </span>
        <div className="thread-head__text">
          <h2 className="channel__title thread-title">
            <span className="thread-title__text">{t("taskManager.queue.title")}</span>
          </h2>
          <span className="channel__topic thread-head__meta">
            {t("taskManager.queue.sub", { name: data?.computer.name ?? name ?? "" })}
          </span>
        </div>
        <Button size="sm" variant="ghost" iconOnly icon="close" aria-label={t("common.close")} onClick={onClose} />
      </header>

      <div className="thread-panel__page tm-panel__body">
        {queue.isLoading && <LoadingList count={3} avatar={false} />}
        {queue.isError && !data && <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />}
        {data && (
          <>
            <div className="tm-line__well">
              {data.line.length > 0 ? (
                <Chip icon="clock">{t("taskManager.queue.full", { count: data.line.length })}</Chip>
              ) : (
                <Chip icon="check">{t("taskManager.queue.room")}</Chip>
              )}
              <span>{t("taskManager.working", { count: data.working.length })}</span>
            </div>
            {data.working.length > 0 && (
              <section className="tm-line__part" aria-label={t("taskManager.queue.working")}>
                <h3 className="tm-panel__h">{`${t("taskManager.queue.working")} · ${data.working.length}`}</h3>
                <ul className="tm-line__list ac-card">
                  {data.working.map((turn) => (
                    <Turn
                      key={turn.runId}
                      turn={turn}
                      time={ago(turn.since)}
                      onOpen={onOpenTask && turn.visible ? () => onOpenTask(turn.runId) : undefined}
                    />
                  ))}
                </ul>
              </section>
            )}
            <section className="tm-line__part" aria-label={t("taskManager.queue.line")}>
              <h3 className="tm-panel__h">{`${t("taskManager.queue.line")} · ${data.line.length}`}</h3>
              {data.line.length === 0 ? (
                <p className="tm-panel__none">{t("taskManager.queue.empty")}</p>
              ) : (
                <ol className="tm-line__list ac-card">
                  {data.line.map((turn, i) => (
                    <Turn
                      key={turn.runId}
                      turn={turn}
                      place={i + 1}
                      first={turn.mine && turn.people}
                      time={ago(turn.since)}
                      stopping={stopping.has(turn.runId)}
                      onStop={() => stop([turn.runId])}
                      onOpen={onOpenTask && turn.visible ? () => onOpenTask(turn.runId) : undefined}
                    />
                  ))}
                </ol>
              )}
            </section>
            <p className="tm-line__note">{t("taskManager.queue.note")}</p>
          </>
        )}
      </div>
    </>
  );
}

/**
 * One turn: its place in the line (none while it runs), the agent's face, "Dev · what it is for" (or whose, to who
 * doesn't see its conversation), "Você vai primeiro" for my own people's turn, how long it has run or waited, Parar.
 */
function Turn({
  turn,
  place,
  first = false,
  time,
  stopping = false,
  onStop,
  onOpen,
}: {
  turn: QueueTurn;
  place?: number;
  first?: boolean;
  time: string | null;
  stopping?: boolean;
  onStop?: () => void;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.anyAgent(turn.agentId)?.name ?? t("channel.unknownAgent");
  const whose = queueWho(t, turn);
  const told = turn.visible && turn.label ? turn.label : null;
  const title = `${name} · ${told ?? whose}`;
  const waiting = place !== undefined;
  const waited = waiting && time ? t("taskManager.queue.waiting", { time }) : null;
  const sub = [told ? whose : null, waited].filter(Boolean).join(" · ");
  return (
    <li className="tm-turn" data-first={first || undefined}>
      {waiting && (
        <span className="tm-turn__place ac-num">{t("taskManager.queue.place", { position: place })}</span>
      )}
      <AgentAvatar agentId={turn.agentId} name={name} size="sm" />
      <span className="tm-turn__text">
        <span className="tm-turn__title">
          {onOpen ? (
            <button type="button" className="tm-turn__open" onClick={onOpen}>
              {title}
            </button>
          ) : (
            <b>{title}</b>
          )}
          {first && <Chip className="tm-turn__first">{t("taskManager.queue.first")}</Chip>}
        </span>
        {sub && <small>{sub}</small>}
      </span>
      {!waiting && time && <span className="tm-turn__time">{t("taskManager.queue.running", { time })}</span>}
      {turn.canStop && onStop && (
        <StopTaskButton label={t("taskManager.actions.stop")} title={title} stopping={stopping} onClick={onStop} />
      )}
    </li>
  );
}

/** "Ver fila" on the page: the line over it, in the side panel a thread opens in. */
export function ComputerLinePanel({
  machineId,
  name,
  onClose,
  onOpenTask,
}: {
  machineId: string;
  name?: string;
  onClose: () => void;
  onOpenTask?: (runId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        className="thread-panel__scrim"
        tabIndex={-1}
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <aside className="thread-panel tm-line" aria-label={t("taskManager.queue.title")}>
        <ComputerLine machineId={machineId} name={name} onClose={onClose} onOpenTask={onOpenTask} />
      </aside>
    </>
  );
}
