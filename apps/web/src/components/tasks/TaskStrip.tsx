import type { ManagedTask } from "@agenteschat/client";
import { markInk } from "@agenteschat/client/lib/activity";
import { taskState, taskTitle, taskWhere, waitsFor } from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import { Button, Chip, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentSpinner } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { boldNames } from "@/components/WorkingLine";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { StopAllInline, StopTaskButton, TaskMark, taskAge, useProgramText, useTaskStop } from "./TaskBits";

/**
 * In a DM with an agent, right above the composer (ADR 0125): "Dev em 3 tarefas · 1 espera você", Ver and "Parar
 * esta" (the task of this conversation). Ver opens the agent's tasks above the line, each with its Parar, this
 * conversation's marked "aqui"; "Parar todas" turns the line itself into its confirmation. While it shows it stands for
 * the agent's work here: the activity pill above the composer gives way to it (ChannelPage).
 */
export function TaskStrip({
  agentId,
  channelId,
  tasks,
}: {
  agentId: string;
  /** This conversation: its task is the one "Parar esta" stops. */
  channelId: string;
  /** The agent's tasks (`tasksOf`), people's first. */
  tasks: ManagedTask[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { stop, stopping } = useTaskStop();
  const here = tasks.find((task) => task.channelId === channelId);
  const waiting = tasks.filter((task) => taskState(task) === "waiting").length;
  const working = tasks.some((task) => taskState(task) === "working");
  const stoppable = tasks.filter((task) => task.canStop && !stopping.has(task.runId)).map((task) => task.runId);
  const hereStops = here?.canStop ? here : undefined;
  return (
    <section className="tm-strip" aria-label={t("taskManager.agentTasks", { name })} data-open={open || undefined}>
      {open && (
        <ul className="tm-strip__rows">
          {tasks.map((task) => (
            <StripRow
              key={task.runId}
              task={task}
              here={task.runId === here?.runId}
              stopping={stopping.has(task.runId)}
              onStop={() => stop([task.runId])}
            />
          ))}
        </ul>
      )}
      {confirming ? (
        <StopAllInline
          agentId={agentId}
          runIds={stoppable}
          onCancel={() => setConfirming(false)}
          onStop={(runIds, reason) => {
            setConfirming(false);
            setOpen(false);
            stop(runIds, reason);
          }}
        />
      ) : (
        <div className="tm-strip__line">
          <span className="tm-strip__mark" aria-hidden="true">
            {working ? <AgentSpinner agentId={agentId} size={14} /> : <WaitMark />}
          </span>
          <span className="tm-strip__text">
            {boldNames(t("taskManager.strip.tasks", { name: markInk(name), count: tasks.length }))}
            {waiting > 0 && (
              <>
                {" · "}
                <span className="tm-strip__waiting">{t("taskManager.strip.waiting", { count: waiting })}</span>
              </>
            )}
          </span>
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t("taskManager.strip.hide") : t("taskManager.strip.see")}
            <Icon name={open ? "chevronDown" : "chevronUp"} size={14} />
          </Button>
          {open && stoppable.length > 1 ? (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              {t("taskManager.actions.stopAll")}
            </Button>
          ) : hereStops ? (
            <StopTaskButton
              label={t("taskManager.strip.stopHere")}
              stopping={stopping.has(hereStops.runId)}
              onClick={() => stop([hereStops.runId])}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

/** One of the agent's tasks: what it is, what it does now or waits for and where, its time, "aqui" and Parar. */
function StripRow({
  task,
  here,
  stopping,
  onStop,
}: {
  task: ManagedTask;
  here: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const now = useNow(30_000);
  const program = useProgramText()(task);
  const title = taskTitle(t, task);
  const where = taskWhere(t, task);
  const wait = waitsFor(task);
  const sub = wait
    ? `${t(wait === "ok" ? "taskManager.state.ok" : "taskManager.state.answer")} · ${where}`
    : taskState(task) === "queued"
      ? `${t("taskManager.state.queued")} · ${where}`
      : here && program
        ? (program.detail ?? program.name)
        : where;
  return (
    <li className="tm-strip__row">
      <TaskMark task={task} />
      <span className="tm-strip__label">
        <b>{title}</b>
        <small data-wait={wait ? true : undefined}>{sub}</small>
      </span>
      {here && <Chip className="tm-here">{t("taskManager.strip.here")}</Chip>}
      <span className="tm-strip__time ac-num">{formatDuration(t, taskAge(task, now))}</span>
      {task.canStop && (
        <StopTaskButton label={t("taskManager.actions.stop")} title={title} stopping={stopping} onClick={onStop} />
      )}
    </li>
  );
}
