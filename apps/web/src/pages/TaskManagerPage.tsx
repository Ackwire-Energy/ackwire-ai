import type { EndedTask, ManagedTask } from "@agenteschat/client";
import { useTaskManager } from "@agenteschat/client";
import { listsAgent } from "@agenteschat/client/lib/audience";
import {
  type AgentTasks,
  activityLine,
  agentSummary,
  endedState,
  groupTasks,
  taskClock,
  taskState,
  tasksOf,
  taskTitle,
  taskWhere,
  todayStart,
} from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import {
  type AgentColor,
  Button,
  Carousel,
  Chip,
  CountChip,
  EmptyState,
  Icon,
  type IconName,
  PixelSpinner,
  PixelStop,
  SearchField,
} from "@agenteschat/ui";
import { type CSSProperties, Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Sparkline } from "@/components/ChartBlock";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { colorOf } from "@/components/Sky";
import { ComputerLinePanel, computerLine } from "@/components/tasks/ComputerLine";
import {
  heatOf,
  ProgramStack,
  StopAllConfirm,
  StopTaskButton,
  TaskMark,
  TaskStateChip,
  taskAge,
  taskSub,
  UsingNow,
  useProgramText,
  useTaskStop,
} from "@/components/tasks/TaskBits";
import { TaskPanel } from "@/components/tasks/TaskPanel";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import "./task-manager.css";

/*
 * The task manager (ADR 0127), one page: the agents as cards with their last half hour (one chosen shows only its
 * tasks), the tasks now (asked by people, grouped by agent, then the routines' background runs) with their state,
 * what each uses, its time, where it runs and Parar, and what ended today at the end. No cost anywhere: here people
 * stop work. A row or an agent chosen gives the toolbar "Ver passos" and "Parar tarefa" / "Parar tudo de Dev".
 */

/** Points on a card's line: the last half hour, one per minute. */
const LINE_POINTS = 30;

/** `agent`: that agent's card chosen as the page opens (`?agent=`, from its tasks' panel in a DM). */
export function TaskManagerPage({ agent }: { agent?: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const view = useTaskManager(org.id, { since: todayStart() });
  const now = useNow(1_000);
  const programText = useProgramText();
  const { stop, stopping, said } = useTaskStop();
  const [q, setQ] = useState("");
  // The agent card chosen (null: Todos), the row chosen (a run id, or `agent:<id>`), agents folded in the table.
  const [card, setCard] = useState<string | null>(agent ?? null);
  useEffect(() => {
    if (agent) setCard(agent);
  }, [agent]);
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [endedOpen, setEndedOpen] = useState(false);
  // Which "Parar tudo" confirmation is open: the toolbar's, or an agent row's (`row:<id>`).
  const [confirm, setConfirm] = useState<string | null>(null);
  // The task whose steps are open in the panel ("Ver passos"); it stays open after the task ends.
  const [panel, setPanel] = useState<string | null>(null);
  // The computer whose line is open in the panel ("Ver fila", ADR 0127); one panel at a time.
  const [lineOf, setLineOf] = useState<{ id: string; name: string } | null>(null);
  const openTask = (runId: string) => {
    setLineOf(null);
    setPanel(runId);
  };
  const openLine = (machine: { id: string; name: string }) => {
    setPanel(null);
    setLineOf(machine);
  };
  // Esc closes the panel, like a thread's; an Escape a dialog over it took is the dialog's alone.
  useEffect(() => {
    if (!panel && !lineOf) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      setPanel(null);
      setLineOf(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, lineOf]);

  const all = view.data?.tasks ?? [];
  const activity = view.data?.activity;
  // The computers with turns running or waiting for room (ADR 0127).
  const computers = view.data?.computers ?? [];
  const nameOf = (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");
  const query = q.trim().toLocaleLowerCase();
  const matches = (task: ManagedTask) => {
    if (!query) return true;
    const using = programText(task);
    return [taskTitle(t, task), taskWhere(t, task), nameOf(task.agentId), using?.name, using?.detail]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  };
  const shown = all.filter(matches);
  const grouped = groupTasks(shown, stopping);
  const summary = agentSummary(all);

  // The cards: who has tasks, in the table's order, then who worked in the last hour; the chosen one stays.
  const lines = useMemo(() => {
    const out = new Map<string | null, number[]>([[null, activityLine(activity ?? {}, null, LINE_POINTS)]]);
    for (const id of Object.keys(activity ?? {})) out.set(id, activityLine(activity ?? {}, id, LINE_POINTS));
    return out;
  }, [activity]);
  const quiet = useMemo(() => Array.from({ length: LINE_POINTS }, () => 0), []);
  const cardIds: string[] = [];
  const addCard = (id: string) => {
    if (!cardIds.includes(id) && listsAgent(org, dir.anyAgent(id))) cardIds.push(id);
  };
  for (const g of groupTasks(all).groups) addCard(g.agentId);
  for (const task of all) addCard(task.agentId);
  const worked = Object.entries(activity ?? {})
    .filter(([, line]) => line.some((n) => n > 0))
    .map(([id]) => id)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const id of worked) addCard(id);
  if (card) addCard(card);

  const selTask = all.find((task) => task.runId === selected);
  const selAgent = card ?? (selected?.startsWith("agent:") ? selected.slice("agent:".length) : null);
  const stoppableOf = (agentId: string) =>
    tasksOf(all, agentId)
      .filter((task) => task.canStop && !stopping.has(task.runId))
      .map((task) => task.runId);
  const pick = (id: string) => {
    setConfirm(null);
    setSelected((s) => (s === id ? null : id));
  };
  const stopOne = (task: ManagedTask) => stop([task.runId]);

  const row = (task: ManagedTask, look: "grouped" | "flat" | "agent") => (
    <TaskRow
      key={task.runId}
      task={task}
      now={now}
      look={look}
      meId={me.user.id}
      agentName={nameOf(task.agentId)}
      selected={selected === task.runId}
      stopping={stopping.has(task.runId)}
      onSelect={() => pick(task.runId)}
      onSteps={() => openTask(task.runId)}
      onLine={openLine}
      onStop={() => stopOne(task)}
    />
  );

  const heading = card ? t("taskManager.agentTasks", { name: nameOf(card) }) : t("taskManager.now");
  const barRunIds = selAgent ? stoppableOf(selAgent) : [];
  const stopTool =
    selTask?.canStop && !stopping.has(selTask.runId) ? (
      <Button size="sm" variant="ghost" className="tm-tool-stop" onClick={() => stopOne(selTask)}>
        <PixelStop size={12} />
        {t("taskManager.actions.stopTask")}
      </Button>
    ) : !selTask && selAgent && barRunIds.length > 0 ? (
      <StopAllConfirm
        agentId={selAgent}
        runIds={barRunIds}
        open={confirm === "bar"}
        onOpenChange={(open) => setConfirm(open ? "bar" : null)}
        onStop={(runIds, reason) => stop(runIds, reason)}
        trigger={
          <Button size="sm" variant="ghost" className="tm-tool-stop">
            <PixelStop size={12} />
            {t("taskManager.actions.stopAllOf", { name: nameOf(selAgent) })}
          </Button>
        }
      />
    ) : (
      <Button size="sm" variant="ghost" disabled>
        <PixelStop size={12} />
        {t("taskManager.actions.stopTask")}
      </Button>
    );

  const endedShown = (e: EndedTask) =>
    (!card || e.agentId === card) &&
    (!query || `${taskTitle(t, e)} ${nameOf(e.agentId)}`.toLocaleLowerCase().includes(query));
  const ended = (view.data?.ended ?? []).filter(endedShown);

  return (
    <div className="page page--list tm">
      <header className="list-head">
        <div>
          <h1>{t("taskManager.title")}</h1>
          {(summary.working > 0 || summary.waiting > 0) && (
            <p className="list-head__sub tm-sum">
              {summary.working > 0 && (
                <span className="tm-sum__item">
                  <PixelSpinner size={14} />
                  {t("taskManager.working", { count: summary.working })}
                </span>
              )}
              {summary.waiting > 0 && (
                <span className="tm-sum__item tm-sum__item--wait">
                  <WaitMark />
                  {t("taskManager.waiting", { count: summary.waiting })}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="list-head__acts tm-search">
          <SearchField
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ("")}
            clearLabel={t("filters.clearSearch")}
            placeholder={t("taskManager.search")}
            aria-label={t("taskManager.search")}
          />
        </div>
      </header>

      {view.isLoading && <LoadingList count={4} avatar={false} />}
      {view.isError && !view.data && <ErrorState error={view.error} onRetry={() => void view.refetch()} />}

      {view.data && cardIds.length > 0 && (
        <Carousel
          label={t("taskManager.cards.label")}
          previousLabel={t("taskManager.cards.previous")}
          nextLabel={t("taskManager.cards.next")}
          className="tm-cards"
        >
          <AgentCard
            agentId={null}
            name={t("taskManager.all")}
            tasks={all}
            line={lines.get(null) ?? quiet}
            color="graphite"
            lineLabel={t("taskManager.activityAll")}
            pressed={card === null}
            onPress={() => {
              setCard(null);
              setSelected(null);
              setConfirm(null);
            }}
          />
          {cardIds.map((id) => (
            <AgentCard
              key={id}
              agentId={id}
              name={nameOf(id)}
              tasks={tasksOf(all, id)}
              line={lines.get(id) ?? quiet}
              color={colorOf(dir.anyAgent(id))}
              lineLabel={t("taskManager.activityOf", { name: nameOf(id) })}
              pressed={card === id}
              onPress={() => {
                setCard((c) => (c === id ? null : id));
                setSelected(null);
                setConfirm(null);
              }}
            />
          ))}
        </Carousel>
      )}

      {computers.length > 0 && (
        <section className="tm-computers" aria-label={t("taskManager.queue.computers")}>
          <div className="list-group-head">
            <h2>{t("taskManager.queue.computers")}</h2>
            <span className="list-group-head__count">{computers.length}</span>
          </div>
          <ul className="tm-computers__list ac-card">
            {computers.map((c) => (
              <li key={c.id} className="tm-computer">
                <span className="tm-computer__icon" aria-hidden="true">
                  <Icon name="computer" size={18} />
                </span>
                <span className="tm-computer__text">
                  <b>{c.name}</b>
                  <small>{computerLine(t, c)}</small>
                </span>
                {(c.inLine > 0 || c.working > 0) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t("taskManager.queue.see")}: ${c.name}`}
                    onClick={() => openLine({ id: c.id, name: c.name })}
                  >
                    {t("taskManager.queue.see")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.data && all.length === 0 && (
        <EmptyState sky icon="chart" title={t("taskManager.empty.title")}>
          {t("taskManager.empty.body")}
        </EmptyState>
      )}

      {view.data && all.length > 0 && (
        <section className="tm-now" aria-label={heading}>
          <div className="tm-tools">
            <h2>{heading}</h2>
            <Button
              size="sm"
              variant="ghost"
              icon="list"
              disabled={!selTask}
              onClick={() => selTask && openTask(selTask.runId)}
            >
              {t("taskManager.actions.steps")}
            </Button>
            {stopTool}
          </div>
          {shown.length === 0 ? (
            <EmptyState icon="search" title={t("taskManager.noResults")} />
          ) : card ? (
            <TaskTable>
              {tasksOf(shown, card).length > 0 ? (
                <ul className="tm-list">{tasksOf(shown, card).map((task) => row(task, "agent"))}</ul>
              ) : (
                <p className="tm-none">{t("taskManager.free")}</p>
              )}
            </TaskTable>
          ) : (
            <TaskTable>
              {grouped.groups.length > 0 && (
                <TaskSection
                  title={t("taskManager.sections.asked")}
                  count={grouped.groups.reduce((n, g) => n + g.tasks.length, 0)}
                >
                  {grouped.groups.map((g) => (
                    <Fragment key={g.agentId}>
                      <AgentRow
                        group={g}
                        name={nameOf(g.agentId)}
                        open={!folded.has(g.agentId)}
                        onToggle={() =>
                          setFolded((was) => {
                            const next = new Set(was);
                            if (!next.delete(g.agentId)) next.add(g.agentId);
                            return next;
                          })
                        }
                        selected={selected === `agent:${g.agentId}`}
                        onSelect={() => pick(`agent:${g.agentId}`)}
                        stopAll={
                          g.stoppable.length > 1 ? (
                            <StopAllConfirm
                              agentId={g.agentId}
                              runIds={g.stoppable}
                              open={confirm === `row:${g.agentId}`}
                              onOpenChange={(open) => setConfirm(open ? `row:${g.agentId}` : null)}
                              onStop={(runIds, reason) => stop(runIds, reason)}
                              trigger={
                                <Button size="sm" className="tm-stop">
                                  <PixelStop size={12} />
                                  {t("taskManager.confirm.stop", { count: g.stoppable.length })}
                                </Button>
                              }
                            />
                          ) : null
                        }
                      />
                      {!folded.has(g.agentId) && g.tasks.map((task) => row(task, "grouped"))}
                    </Fragment>
                  ))}
                </TaskSection>
              )}
              {grouped.background.length > 0 && (
                <TaskSection title={t("taskManager.sections.background")} count={grouped.background.length}>
                  {grouped.background.map((task) => row(task, "flat"))}
                </TaskSection>
              )}
            </TaskTable>
          )}
        </section>
      )}

      {view.data && (
        <section className="tm-ended" aria-label={t("taskManager.ended.title")}>
          <button type="button" className="tm-more" aria-expanded={endedOpen} onClick={() => setEndedOpen((o) => !o)}>
            <Icon name="chevronRight" size={16} className="tm-more__chevron" />
            {t("taskManager.ended.title")}
            <CountChip size="sm">{ended.length}</CountChip>
          </button>
          {endedOpen &&
            (ended.length > 0 ? (
              <ul className="tm-list tm-list--ended ac-card">
                {ended.map((e) => (
                  <EndedRow key={e.runId} task={e} agentName={nameOf(e.agentId)} meId={me.user.id} />
                ))}
              </ul>
            ) : (
              <p className="tm-none">{t("taskManager.ended.none")}</p>
            ))}
        </section>
      )}

      {/* Hung from the shell, like a thread's panel beside its channel: inside the page it would scroll away with the
          list (the page's entrance animation keeps the page a containing block). */}
      {panel &&
        createPortal(
          <TaskPanel
            key={panel}
            runId={panel}
            task={all.find((task) => task.runId === panel)}
            ended={view.data?.ended.find((e) => e.runId === panel)}
            stopping={stopping.has(panel)}
            said={said.get(panel)}
            now={now}
            onStop={() => stop([panel])}
            onClose={() => setPanel(null)}
          />,
          document.querySelector(".shell") ?? document.body,
        )}
      {lineOf &&
        createPortal(
          <ComputerLinePanel
            key={lineOf.id}
            machineId={lineOf.id}
            name={lineOf.name}
            onClose={() => setLineOf(null)}
            onOpenTask={openTask}
          />,
          document.querySelector(".shell") ?? document.body,
        )}
    </div>
  );
}

/** The table: the columns' names (for the eye; each cell says what it is), then its sections. */
function TaskTable({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="tm-table ac-card">
      <div className="tm-row tm-row--head" aria-hidden="true">
        <span>{t("taskManager.columns.task")}</span>
        <span>{t("taskManager.columns.state")}</span>
        <span>{t("taskManager.columns.using")}</span>
        <span className="tm-cell--time">{t("taskManager.columns.time")}</span>
        <span className="tm-cell--where">{t("taskManager.columns.computer")}</span>
        <span />
      </div>
      {children}
    </div>
  );
}

/** "Pedidas por pessoas 6", "Rotinas em segundo plano 2": a section of the table. */
function TaskSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="tm-section" aria-label={title}>
      <h3 className="tm-sec">
        {title}
        <span className="tm-sec__count">{count}</span>
      </h3>
      <ul className="tm-list">{children}</ul>
    </section>
  );
}

/**
 * One task: what it is (the whole row picks it), its state, what it uses now, its time (shaded as it grows), where it
 * runs and Parar. `grouped` sits under its agent's row; `flat` (a routine's background run) shows its agent's face;
 * `agent` is the list of one agent's tasks (its card chosen).
 */
function TaskRow({
  task,
  now,
  look,
  meId,
  agentName,
  selected,
  stopping,
  onSelect,
  onSteps,
  onLine,
  onStop,
}: {
  task: ManagedTask;
  now: number;
  look: "grouped" | "flat" | "agent";
  meId: string;
  agentName: string;
  selected: boolean;
  stopping: boolean;
  onSelect: () => void;
  /** "Ver passos": its panel. */
  onSteps: () => void;
  /** Its computer's line ("Onde roda", ADR 0127). */
  onLine: (machine: { id: string; name: string }) => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const title = taskTitle(t, task);
  const where = taskWhere(t, task);
  const asked = task.requester
    ? task.requester.userId === meId
      ? t("taskManager.askedByYou")
      : t("taskManager.askedBy", { name: task.requester.name })
    : null;
  const sub =
    look === "flat"
      ? `${agentName} · ${where}`
      : taskSub(t, task, [where, task.background ? null : asked].filter(Boolean).join(" · "));
  const age = taskAge(task, now);
  const machine = task.machine;
  // A routine's run shows its agent's face (its section has no agent rows); a person's task, its state's mark.
  const face = <AgentAvatar agentId={task.agentId} name={agentName} size="xs" />;
  return (
    <li className="tm-row" data-look={look} data-selected={selected || undefined}>
      <span className="tm-cell tm-cell--name">
        {look === "flat" ? face : <TaskMark task={task} />}
        <span className="tm-name">
          <button type="button" className="tm-hit" aria-pressed={selected} onClick={onSelect}>
            {title}
          </button>
          <small>{sub}</small>
        </span>
      </span>
      <span className="tm-cell tm-cell--state">
        <TaskStateChip task={task} stopping={stopping} />
      </span>
      <span className="tm-cell tm-cell--use">
        <UsingNow task={task} />
      </span>
      <span className="tm-cell tm-cell--time ac-num" style={{ "--h": heatOf(age) } as CSSProperties}>
        {taskClock(age)}
      </span>
      <span className="tm-cell tm-cell--where">
        {machine ? (
          // On a computer: it opens that computer's line.
          <button
            type="button"
            className="tm-where"
            aria-label={`${t("taskManager.queue.see")}: ${machine.name}`}
            title={t("taskManager.queue.see")}
            onClick={() => onLine(machine)}
          >
            <Icon name="computer" size={14} />
            <span className="tm-ellipsis">{machine.name}</span>
          </button>
        ) : (
          <span className="tm-ellipsis">{t("taskManager.servers")}</span>
        )}
      </span>
      <span className="tm-cell tm-cell--act">
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="list"
          aria-label={`${t("taskManager.actions.steps")}: ${title}`}
          title={t("taskManager.actions.steps")}
          onClick={onSteps}
        />
        {task.canStop && (
          <StopTaskButton label={t("taskManager.actions.stop")} title={title} stopping={stopping} onClick={onStop} />
        )}
      </span>
    </li>
  );
}

/** An agent's row over its tasks: fold, its face and count, how it stands, the apps it uses now, "Parar 2". */
function AgentRow({
  group,
  name,
  open,
  onToggle,
  selected,
  onSelect,
  stopAll,
}: {
  group: AgentTasks;
  name: string;
  open: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: () => void;
  stopAll: ReactNode;
}) {
  const { t } = useTranslation();
  // Waiting beats queued, working beats both (someone waits on it while it works on something else).
  const working = group.tasks.find((task) => taskState(task) === "working");
  const state = working ? (
    <TaskStateChip task={working} />
  ) : group.waiting > 0 ? (
    <Chip tone="waiting" lead={<WaitMark />}>
      {t("taskManager.waiting", { count: group.waiting })}
    </Chip>
  ) : (
    <Chip icon="clock">{t("taskManager.state.queued")}</Chip>
  );
  return (
    <li className="tm-row tm-row--agent" data-selected={selected || undefined}>
      <span className="tm-cell tm-cell--name">
        <button
          type="button"
          className="tm-twist"
          aria-expanded={open}
          aria-label={t("taskManager.toggleAgent", { name })}
          onClick={onToggle}
        >
          <Icon name="chevronDown" size={14} />
        </button>
        <AgentAvatar agentId={group.agentId} name={name} size="sm" />
        <span className="tm-name">
          <button type="button" className="tm-hit" aria-pressed={selected} onClick={onSelect}>
            {name}
          </button>
        </span>
        <CountChip size="sm" aria-label={t("taskManager.tasks", { count: group.tasks.length })}>
          {group.tasks.length}
        </CountChip>
      </span>
      <span className="tm-cell tm-cell--state">{state}</span>
      <span className="tm-cell tm-cell--use">
        <ProgramStack tasks={group.tasks} />
      </span>
      <span className="tm-cell tm-cell--time" />
      <span className="tm-cell tm-cell--where" />
      <span className="tm-cell tm-cell--act">{stopAll}</span>
    </li>
  );
}

/** One agent on a card: its face, name and tasks, who waits on it, and its last half hour edge to edge. */
function AgentCard({
  agentId,
  name,
  tasks,
  line,
  color,
  lineLabel,
  pressed,
  onPress,
}: {
  /** Null: "Todos", every task. */
  agentId: string | null;
  name: string;
  tasks: ManagedTask[];
  line: number[];
  color: AgentColor;
  lineLabel: string;
  pressed: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { waiting } = agentSummary(tasks);
  return (
    <button type="button" className="tm-card ac-card ac-card--interactive" aria-pressed={pressed} onClick={onPress}>
      <span className="tm-card__head">
        {agentId ? (
          <AgentAvatar agentId={agentId} name={name} size="sm" />
        ) : (
          <span className="tm-card__n ac-num" aria-hidden="true">
            {tasks.length}
          </span>
        )}
        <span className="tm-card__text">
          <b>{name}</b>
          <small>{tasks.length > 0 ? t("taskManager.tasks", { count: tasks.length }) : t("taskManager.free")}</small>
        </span>
        {waiting > 0 && (
          <Chip
            tone="waiting"
            lead={<WaitMark />}
            className="tm-card__wait"
            title={t("taskManager.waiting", { count: waiting })}
            aria-label={t("taskManager.waiting", { count: waiting })}
          >
            {waiting}
          </Chip>
        )}
      </span>
      <Sparkline values={line} color={color} label={lineLabel} />
    </button>
  );
}

const ENDED_ICON: Record<"done" | "stopped" | "failed", IconName> = {
  done: "check",
  stopped: "stop",
  failed: "alert",
};

/** What ended today: the task, its agent and where, how it ended (and who stopped it), how long it took. */
function EndedRow({ task, agentName, meId }: { task: EndedTask; agentName: string; meId: string }) {
  const { t } = useTranslation();
  const state = endedState(task);
  const word =
    state === "stopped"
      ? task.stoppedBy && task.stoppedBy.userId !== meId
        ? t("taskManager.ended.stoppedBy", { name: task.stoppedBy.name })
        : t("taskManager.ended.stopped")
      : t(state === "done" ? "taskManager.ended.done" : "taskManager.ended.failed");
  const took = Date.parse(task.finishedAt) - Date.parse(task.startedAt ?? task.finishedAt);
  return (
    <li className="tm-row tm-row--ended">
      <span className="tm-cell tm-cell--name">
        <AgentAvatar agentId={task.agentId} name={agentName} size="xs" />
        <span className="tm-name">
          <span className="tm-name__title">{taskTitle(t, task)}</span>
          <small>{`${agentName} · ${taskWhere(t, task)}`}</small>
        </span>
      </span>
      <span className="tm-cell tm-cell--state">
        <Chip icon={ENDED_ICON[state]}>{word}</Chip>
      </span>
      <span className="tm-cell tm-cell--time ac-num">{formatDuration(t, Math.max(0, took))}</span>
    </li>
  );
}
