import type { ManagedTask } from "@agenteschat/client";
import { useCatalog, useStopReason, useStopTasks } from "@agenteschat/client";
import { activityVerb, appLabel } from "@agenteschat/client/lib/activity";
import { capitalize, joinNames } from "@agenteschat/client/lib/format";
import { brainName } from "@agenteschat/client/lib/outages";
import { playSound } from "@agenteschat/client/lib/sounds";
import {
  linePlace,
  programKey,
  type TaskProgram,
  taskProgram,
  taskSince,
  taskState,
  waitKey,
  waitsFor,
  waitsOnPerson,
} from "@agenteschat/client/lib/task-manager";
import { callLogo, formatDuration } from "@agenteschat/client/lib/work";
import { Button, Chip, cx, Icon, Input, PixelStop, Popover, ProviderLogo, Spinner } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { useCallLogo } from "@/components/ToolCalls";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { useToast } from "@/lib/toast";
import { useLiveStore } from "@/realtime/context";
import "./tasks.css";

/*
 * The task manager's pieces (ADR 0127), the same on its page and in an agent's panel beside its DM: a task's state,
 * what it uses now, its stop and the confirmation that stops several at once.
 */

/** A task's time on its clock, as the "Tempo" column shades it: full at 40 minutes. */
export const HEAT_FULL_MS = 40 * 60_000;
export const heatOf = (ms: number) => Math.min(1, Math.max(0, ms / HEAT_FULL_MS));

/** How long a task has been at it, in ms. */
export const taskAge = (task: Pick<ManagedTask, "startedAt" | "createdAt">, now: number) =>
  Math.max(0, now - taskSince(task));

/**
 * Stops tasks (one at once, several from a confirmation): the stop sound, "Parando…" on them here and on their live
 * block in a conversation, and a toast when some of several couldn't be stopped.
 */
export function useTaskStop() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const live = useLiveStore();
  const toast = useToast();
  const mutation = useStopTasks(org.id);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  // The reason said with a stop, by task: what its panel shows once it stopped.
  const [said, setSaid] = useState<ReadonlyMap<string, string>>(() => new Map());
  const release = (runIds: string[]) =>
    setStopping((was) => {
      const next = new Set(was);
      for (const id of runIds) next.delete(id);
      return next;
    });
  const stop = (runIds: string[], reason?: string) => {
    if (runIds.length === 0) return;
    const why = reason?.trim() || undefined;
    playSound("stop");
    setStopping((was) => new Set([...was, ...runIds]));
    if (why) setSaid((was) => new Map([...was, ...runIds.map((id) => [id, why] as const)]));
    for (const id of runIds) live.stopping(id, me.user.id);
    mutation.mutate(
      { runIds, reason: why },
      {
        onSuccess: (out) => {
          if (out.failed === 0) return;
          toast.show(t("taskManager.failed"), "error");
          // Which ones failed isn't said: once the list is asked again, the stopped ones are gone and the rest
          // show as they are.
          setTimeout(() => release(runIds), 4_000);
        },
        // Refused as a whole: the app's own toast says why (the mutation isn't silent); they're back as they were.
        onError: () => {
          for (const id of runIds) live.unstopping(id);
          release(runIds);
        },
      },
    );
  };
  return { stop, stopping, said };
}

/**
 * "Dizer por quê" after a stop (only who stopped it, once): a field and Mandar; the agent reads it on its next turn.
 * Enter sends, Esc leaves it.
 */
export function SayWhy({
  runId,
  onSent,
  onCancel,
  autoFocus = false,
  className,
}: {
  runId: string;
  onSent: (reason: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const save = useStopReason(org.id);
  const [text, setText] = useState("");
  const send = () => {
    const why = text.trim();
    if (!why || save.isPending) return;
    save.mutate({ runId, reason: why }, { onSuccess: () => onSent(why) });
  };
  return (
    <span className={cx("tm-saywhy", className)}>
      <ReasonInput
        value={text}
        onChange={setText}
        onEnter={send}
        onEscape={onCancel}
        placeholder={t("taskManager.stopped.whyPlaceholder")}
        autoFocus={autoFocus}
      />
      <Button size="sm" disabled={!text.trim()} loading={save.isPending} onClick={send}>
        {t("taskManager.stopped.send")}
      </Button>
    </span>
  );
}

/**
 * What a task waits for, in words: "Espera seu ok", "Na fila · 2º" with its place in its computer's line (ADR 0127),
 * "Computador cheio" when the line isn't known, "Esperando o plano"…; null when it waits for nothing.
 */
export function waitWords(t: TFunction, task: Pick<ManagedTask, "status" | "held" | "line">): string | null {
  const place = linePlace(task);
  if (place) return t("taskManager.state.inLine", { position: place.position });
  const wait = waitsFor(task);
  return wait ? t(waitKey(wait)) : null;
}

/** "Trabalhando" (the orbit in the agent's color), "Espera seu ok" / "Espera resposta", "Na fila", "Parando…". */
export function TaskStateChip({ task, stopping = false }: { task: ManagedTask; stopping?: boolean }) {
  const { t } = useTranslation();
  if (stopping) return <Chip lead={<Spinner size={14} />}>{t("taskManager.state.stopping")}</Chip>;
  const state = taskState(task);
  if (state === "working")
    return <Chip lead={<AgentSpinner agentId={task.agentId} size={14} />}>{t("taskManager.state.working")}</Chip>;
  if (state === "waiting") {
    const words = waitWords(t, task) ?? t(waitKey("answer"));
    // A wait on a computer (its place in its line), a plan or a budget isn't "espera você": grey, with the clock.
    return waitsOnPerson(task) ? (
      <Chip tone="waiting" lead={<WaitMark />}>
        {words}
      </Chip>
    ) : (
      <Chip icon="clock">{words}</Chip>
    );
  }
  return <Chip icon="clock">{t("taskManager.state.queued")}</Chip>;
}

/** The small mark before a task's title: the orbit while it works, the waiting square, the clock in the queue. */
export function TaskMark({ task }: { task: ManagedTask }) {
  const state = taskState(task);
  return (
    <span className="tm-mark" aria-hidden="true">
      {state === "working" ? (
        <AgentSpinner agentId={task.agentId} size={14} />
      ) : state === "waiting" && waitsOnPerson(task) ? (
        <WaitMark />
      ) : (
        <Icon name="clock" size={14} />
      )}
    </span>
  );
}

export interface ProgramText {
  name: string;
  detail: string | null;
}

/** "Navegador", "GitHub", "Claude Code"… and the line under it ("página de cancelar", "Navegador · testes"). */
export function useProgramText() {
  const { t, i18n } = useTranslation();
  const catalog = useCatalog();
  const connectors = catalog.data?.connectors ?? [];
  const named = (p: Exclude<TaskProgram, { kind: "none" } | { kind: "brain" }>): ProgramText => {
    const verb = capitalize(activityVerb(t, p.activity), i18n.language);
    switch (p.kind) {
      case "browser":
        return { name: t("taskManager.program.browser"), detail: p.detail ?? verb };
      case "screen":
        return { name: t("taskManager.program.screen"), detail: p.detail ?? verb };
      case "terminal":
        return { name: t("taskManager.program.terminal"), detail: p.detail ?? verb };
      case "agentes":
        return { name: t("taskManager.program.agentes"), detail: [verb, p.detail].filter(Boolean).join(" · ") };
      default: {
        const logo = callLogo(p.activity, connectors);
        const name =
          (logo.kind === "service" && logo.label) ||
          appLabel(p.activity) ||
          capitalize(p.activity.service ?? "", i18n.language) ||
          t("taskManager.program.agentes");
        return { name, detail: p.detail ?? verb };
      }
    }
  };
  return (task: ManagedTask): ProgramText | null => {
    const p = taskProgram(task);
    if (p.kind === "none") {
      // At work with no tool called yet, it thinks; queued or waiting on a person, it uses nothing.
      return task.status === "running" ? { name: t("taskManager.program.thinking"), detail: null } : null;
    }
    if (p.kind !== "brain") return named(p);
    const within = p.inner;
    const inner = within && within.kind !== "none" && within.kind !== "brain" ? named(within) : null;
    return {
      name: brainName(p.brain),
      detail: inner
        ? inner.detail
          ? t("taskManager.program.inside", { program: inner.name, detail: inner.detail })
          : inner.name
        : p.detail,
    };
  };
}

/** A program's logo as a 20px tile: the brain's maker, the connector's mark, or the icon of one of our tools. */
export function ProgramLogo({ program }: { program: TaskProgram }) {
  const logo = useCallLogo();
  if (program.kind === "none") return null;
  if (program.kind === "brain") return <ProviderLogo id={program.brain} size="chip" className="tm-logo" />;
  return <span className="tm-logo">{logo(program.activity)}</span>;
}

/** "Usando agora": the logo, the program and what it does in it; a dash in the queue, its wait in a computer's line. */
export function UsingNow({ task }: { task: ManagedTask }) {
  const { t } = useTranslation();
  const text = useProgramText()(task);
  const place = linePlace(task);
  const now = useNow(place?.since ? 30_000 : false);
  if (place) {
    // In its computer's line it uses nothing yet: how long it has waited for its turn.
    const waited = place.since ? formatDuration(t, Math.max(0, now - Date.parse(place.since))) : null;
    return (
      <span className="tm-use tm-use--none">{waited ? t("taskManager.queue.waiting", { time: waited }) : "—"}</span>
    );
  }
  if (!text) return <span className="tm-use tm-use--none">—</span>;
  return (
    <span className="tm-use">
      <ProgramLogo program={taskProgram(task)} />
      <span className="tm-use__text">
        <b>{text.name}</b>
        {text.detail && <small>{text.detail}</small>}
      </span>
    </span>
  );
}

/** What an agent's tasks use, each program once: their logos, overlapping (its row in the table). */
export function ProgramStack({ tasks }: { tasks: ManagedTask[] }) {
  const { t } = useTranslation();
  const text = useProgramText();
  const seen = new Map<string, { program: TaskProgram; name: string }>();
  for (const task of tasks) {
    const program = taskProgram(task);
    const key = programKey(program);
    const name = text(task)?.name;
    if (key && name && !seen.has(key)) seen.set(key, { program, name });
  }
  if (seen.size === 0) return null;
  const all = [...seen.values()];
  return (
    <span
      className="tm-logos"
      role="img"
      aria-label={t("taskManager.using", {
        names: joinNames(
          all.map((p) => p.name),
          t,
        ),
      })}
    >
      {[...seen.entries()].map(([key, p]) => (
        <ProgramLogo key={key} program={p.program} />
      ))}
    </span>
  );
}

/** "Parar": the stop square and the word; "Parando…" with the orbit once pressed. */
export function StopTaskButton({
  label,
  stopping = false,
  onClick,
  title,
  className,
}: {
  label: string;
  stopping?: boolean;
  onClick: () => void;
  /** The task it stops, for screen readers ("Parar: Corrigir o link"). */
  title?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      className={cx("tm-stop", className)}
      disabled={stopping}
      aria-label={title && !stopping ? `${label}: ${title}` : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {stopping ? <Spinner size={14} /> : <PixelStop size={12} />}
      {stopping ? t("taskManager.state.stopping") : label}
    </Button>
  );
}

/** Where a task's steps show: its conversation (its thread, the DM), or the routine behind a background run. */
export function useOpenTask() {
  const { org } = useOrg();
  const navigate = useNavigate();
  return (task: Pick<ManagedTask, "agentId" | "channelId" | "channelKind" | "threadId" | "background" | "routine">) => {
    const orgId = org.id;
    if (task.background && task.routine)
      void navigate({ to: "/org/$orgId/routines", params: { orgId }, search: { open: task.routine.id } });
    else if (task.threadId)
      void navigate({ to: "/org/$orgId/threads/$threadId", params: { orgId, threadId: task.threadId } });
    else if (task.channelKind === "dm")
      void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId, agentId: task.agentId } });
    else void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId, channelId: task.channelId } });
  };
}

/** The optional reason, sent with the stop: Enter stops, Esc leaves it. */
function ReasonInput({
  value,
  onChange,
  onEnter,
  onEscape,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  onEscape?: () => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <Input
      className="tm-why"
      value={value}
      maxLength={500}
      placeholder={placeholder}
      aria-label={placeholder}
      autoComplete="off"
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        } else if (e.key === "Escape" && onEscape) {
          e.preventDefault();
          e.stopPropagation();
          onEscape();
        }
      }}
    />
  );
}

/**
 * "Parar tudo de Dev": a card under the button with the agent's face, what happens ("O que já foi feito fica guardado,
 * e Dev fica sabendo"), an optional reason the agent reads, Cancelar and "Parar 3".
 */
export function StopAllConfirm({
  agentId,
  runIds,
  open,
  onOpenChange,
  onStop,
  trigger,
}: {
  agentId: string;
  runIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStop: (runIds: string[], reason: string) => void;
  trigger: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!open) setReason("");
  }, [open]);
  const count = runIds.length;
  const title = t("taskManager.confirm.title", { count, name });
  const confirm = () => {
    onOpenChange(false);
    onStop(runIds, reason);
  };
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      label={title}
      side="bottom"
      align="end"
      className="tm-confirm"
    >
      <div className="tm-confirm__head">
        <AgentAvatar agentId={agentId} name={name} size="sm" />
        <div className="tm-confirm__text">
          <b>{title}</b>
          <p>{t("taskManager.confirm.body", { name })}</p>
        </div>
      </div>
      <ReasonInput
        value={reason}
        onChange={setReason}
        onEnter={confirm}
        placeholder={t("taskManager.confirm.reason")}
      />
      <div className="tm-confirm__acts">
        <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" variant="primary" disabled={count === 0} onClick={confirm}>
          <PixelStop size={12} />
          {t("taskManager.confirm.stop", { count })}
        </Button>
      </div>
    </Popover>
  );
}

/**
 * The same confirmation in one line, in place of an agent's panel's foot: "Parar as 3 tarefas de Dev? Dev fica
 * sabendo que você parou." [Por quê?] Cancelar · Parar 3.
 */
export function StopAllInline({
  agentId,
  runIds,
  onCancel,
  onStop,
}: {
  agentId: string;
  runIds: string[];
  onCancel: () => void;
  onStop: (runIds: string[], reason: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
  const [reason, setReason] = useState("");
  const count = runIds.length;
  const title = t("taskManager.confirm.title", { count, name });
  const confirm = () => onStop(runIds, reason);
  return (
    <div className="tm-cfm" role="alertdialog" aria-label={title}>
      <span className="tm-cfm__text">
        <AgentSpinner agentId={agentId} size={14} />
        <span>
          <b>{title}</b> {t("taskManager.confirm.short", { name })}
        </span>
      </span>
      <span className="tm-cfm__acts">
        <ReasonInput
          value={reason}
          onChange={setReason}
          onEnter={confirm}
          onEscape={onCancel}
          placeholder={t("taskManager.confirm.reason")}
          autoFocus
        />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" variant="primary" disabled={count === 0} onClick={confirm}>
          <PixelStop size={12} />
          {t("taskManager.confirm.stop", { count })}
        </Button>
      </span>
    </div>
  );
}

/** "#produto · 9 de 14 feitos": where a task is (`taskWhere`), and its plan's progress for a long work. */
export function taskSub(t: TFunction, task: Pick<ManagedTask, "plan">, where: string) {
  const plan = task.plan ? t("taskManager.plan", { done: task.plan.done, total: task.plan.total }) : null;
  return [where, plan].filter(Boolean).join(" · ");
}
