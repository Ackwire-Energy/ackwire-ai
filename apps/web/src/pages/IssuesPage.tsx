import type { Issue, IssuePriority, IssueStatus } from "@agenteschat/client";
import { useIssueAction, useIssues } from "@agenteschat/client";
import { dueLabel, parseDayInput, relativeTime, toYmd } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  Button,
  Chip,
  CriteriaPixels,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  FilterBar,
  FilterChip,
  FilterToggle,
  Icon,
  Input,
  SearchField,
  Segmented,
  Select,
  Textarea,
  Toolbar,
  WorkSweep,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type DragEvent, type MouseEvent, useDeferredValue, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { actorFromKey, NO_ACTOR, useActors } from "@/components/actors";
import { useActorFilterOptions, useFilterCopy } from "@/components/filters";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import {
  BOARD,
  isOpen,
  isStalled,
  isWorking,
  PRIORITIES,
  STATUS_ICON,
  STATUSES,
  splitCriteria,
  useAssigneeColor,
  useStepText,
} from "@/lib/issues";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import { IssueDialog } from "./IssuePage";
import "./issues.css";

export { BOARD, PRIORITIES, STATUSES, splitCriteria } from "@/lib/issues";

type Filter = "all" | "agents" | "people" | "mine" | "none";
const FILTERS: Filter[] = ["all", "agents", "people", "mine", "none"];

export function StatusChip({ status }: { status: IssueStatus }) {
  const { t } = useTranslation();
  return <Chip icon={STATUS_ICON[status]}>{t(`issues.status.${status}`)}</Chip>;
}

/** Issues (telas/Issues.html): agents working now, a board by status (drag between columns) or a list, a details panel. */
export function IssuesPage() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const [view, setView] = useState<"board" | "list">("board");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [assignees, setAssignees] = useState<string[]>([]);
  const [priority, setPriority] = useState<string[]>([]);
  // The open issue lives in the URL (`?open=131`): a reload or a shared link reopens it.
  const [openParam, setOpenParam] = useOpenParam();
  const openNumber = openParam && /^\d+$/.test(openParam) ? Number(openParam) : null;
  const actorOptions = useActorFilterOptions();
  const copy = useFilterCopy();
  const searchRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const search = useDeferredValue(q.trim());
  const issues = useIssues(org.id, search);
  const all = issues.data ?? [];
  const pass = (i: Issue, f: Filter) =>
    f === "all" ||
    (f === "agents" && i.assignee?.type === "agent") ||
    (f === "people" && i.assignee?.type === "person") ||
    (f === "mine" && i.assignee?.type === "person" && i.assignee.id === me.user.id) ||
    (f === "none" && !i.assignee);
  const visible = all.filter(
    (i) =>
      pass(i, filter) &&
      (assignees.length === 0 || (i.assignee !== null && assignees.includes(`${i.assignee.type}:${i.assignee.id}`))) &&
      (priority.length === 0 || priority.includes(i.priority)),
  );
  const open = all.filter(isOpen);
  const opened = all.find((i) => i.number === openNumber) ?? null;
  const toggle = (n: number) => setOpenParam(openNumber === n ? null : n);
  // "N" opens "Nova issue", "/" the search (not while typing or in a dialog; the details dialog closes itself on Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu], [role=listbox]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setCreating(true);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="page issues">
      <div className="issues__main">
        <header className="issues-head">
          <div>
            <h1>{t("issues.title")}</h1>
            <p className="issues-head__sub">
              <span>
                {t("issues.summary", {
                  open: open.length,
                  agents: open.filter((i) => i.assignee?.type === "agent").length,
                })}
              </span>
              {open.some((i) => !i.assignee) && (
                <span> · {t("issues.unassigned", { count: open.filter((i) => !i.assignee).length })}</span>
              )}
            </p>
          </div>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {t("issues.new")}
          </Button>
        </header>
        <WorkingNow issues={all} onOpen={toggle} />
        <Toolbar
          search={
            <SearchField
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              clearLabel={copy.clearSearch}
              placeholder={t("issues.search")}
              aria-label={t("issues.search")}
            />
          }
          actions={
            <Segmented
              label={t("issues.view")}
              value={view}
              onValueChange={setView}
              options={[
                {
                  value: "board",
                  label: (
                    <>
                      <Icon name="grid" size={16} />
                      {t("issues.board")}
                    </>
                  ),
                },
                {
                  value: "list",
                  label: (
                    <>
                      <Icon name="list" size={16} />
                      {t("issues.list")}
                    </>
                  ),
                },
              ]}
            />
          }
        >
          {/* biome-ignore lint/a11y/useSemanticElements: filter pills */}
          <span className="ac-filterbar" role="group" aria-label={t("issues.filters")}>
            {FILTERS.map((f) => (
              <FilterToggle
                key={f}
                pressed={filter === f}
                onPressedChange={() => setFilter(f)}
                count={all.filter((i) => isOpen(i) && pass(i, f)).length}
              >
                {t(`issues.filter.${f}`)}
              </FilterToggle>
            ))}
          </span>
          <FilterBar
            label={t("issues.moreFilters")}
            clearText={copy.clearAll}
            onClear={() => {
              setAssignees([]);
              setPriority([]);
            }}
            filters={[
              {
                key: "assignee",
                active: assignees.length > 0,
                node: (
                  <FilterChip
                    label={t("issues.assigneeFilter")}
                    icon="person"
                    multiple
                    options={actorOptions}
                    value={assignees}
                    onChange={setAssignees}
                    valueText={(o) => o.label}
                    countText={copy.people}
                    clearLabel={copy.clearOf(t("issues.assigneeFilter"))}
                    searchLabel={copy.searchLabel}
                    searchPlaceholder={copy.searchPlaceholder}
                    noResults={copy.noResults}
                  />
                ),
              },
              {
                key: "priority",
                active: priority.length > 0,
                node: (
                  <FilterChip
                    label={t("issues.priorityFilter")}
                    icon="alert"
                    options={(["high", "normal", "low"] as const).map((p) => ({
                      value: p,
                      label: t(`issues.priority.${p}`),
                    }))}
                    value={priority}
                    onChange={setPriority}
                    clearLabel={copy.clearOf(t("issues.priorityFilter"))}
                  />
                ),
              },
            ]}
          />
        </Toolbar>
        {issues.isLoading &&
          (view === "board" ? (
            <div className="issues-board">
              {BOARD.map((status) => (
                <section key={status} className="issues-col" aria-label={t(`issues.status.${status}`)}>
                  <div className="issues-col__head">
                    <h2>{t(`issues.status.${status}`)}</h2>
                  </div>
                  <LoadingCards count={2} className="loading-cards loading-cards--tight" />
                </section>
              ))}
            </div>
          ) : (
            <LoadingList count={5} avatar={false} trailing />
          ))}
        {issues.isError && !issues.data && <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />}
        {issues.isSuccess && all.length === 0 && !search && (
          <EmptyState
            sky
            title={t("issues.emptyTitle")}
            actions={
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                {t("issues.new")}
              </Button>
            }
          >
            {t("issues.empty")}
          </EmptyState>
        )}
        {issues.isSuccess && visible.length === 0 && (all.length > 0 || search) && (
          <EmptyState icon="search">{t("issues.noResults")}</EmptyState>
        )}
        {visible.length > 0 && view === "board" && <Board issues={visible} openNumber={openNumber} onOpen={toggle} />}
        {visible.length > 0 && view === "list" && (
          <IssueList issues={visible} openNumber={openNumber} onOpen={toggle} />
        )}
      </div>
      {opened && <IssueDialog issue={opened} onClose={() => setOpenParam(null)} />}
      <NewIssueDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/** The agents on issues right now (live runs), then the stalled ones (in progress, no run alive). */
function WorkingNow({ issues, onOpen }: { issues: Issue[]; onOpen: (n: number) => void }) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const color = useAssigneeColor();
  const stepText = useStepText();
  const working = issues.filter((i) => isOpen(i) && isWorking(i));
  const stalled = issues.filter((i) => isOpen(i) && isStalled(i));
  if (working.length + stalled.length === 0) return null;
  return (
    <section className="issues-now" aria-label={t("issues.now.title")}>
      <h2 className="issues-now__title">
        {t("issues.now.title")}
        <span>{working.length}</span>
        {stalled.length > 0 && <span>· {t("issues.now.stalled", { count: stalled.length })}</span>}
      </h2>
      <div className="issues-now__list">
        {[...working, ...stalled].map((i) => {
          const w = i.work;
          if (!w || !i.assignee) return null;
          const name = actors.name(i.assignee);
          const stall = w.state === "stalled";
          const waiting = w.state === "waiting_approval" || w.state === "waiting_input";
          const step = stepText(w.steps.at(-1));
          return (
            <button
              key={i.id}
              type="button"
              className={cx("issues-now__card", stall && "is-stalled", waiting && "is-waiting")}
              onClick={() => onOpen(i.number)}
            >
              <AgentAvatar
                agentId={i.assignee.id}
                name={name}
                size="md"
                state={stall ? "idle" : waiting ? "idle" : "writing"}
                running={!stall && !waiting}
                expression={stall ? "closed" : undefined}
              />
              <span className="issues-now__text">
                <span className="issues-now__who">
                  {name} · #{i.number} ·{" "}
                  {stall
                    ? t("issues.work.stalled", { when: relativeTime(t, i18n.language, w.since) })
                    : relativeTime(t, i18n.language, w.since)}
                </span>
                <b>{i.title}</b>
                <span className={cx("issues-now__step", !stall && !waiting && "is-live")}>
                  {stall
                    ? step
                      ? t("issues.work.noRunStep", { step })
                      : t("issues.work.noRun")
                    : waiting
                      ? t(w.state === "waiting_approval" ? "issues.work.waitingApproval" : "issues.work.waitingInput")
                      : step || t("issues.work.starting")}
                </span>
                {stall && (
                  <span className="issues-now__go">
                    <Icon name="play" size={14} />
                    {t("issues.work.continue")}
                  </span>
                )}
              </span>
              {!stall && <WorkSweep color={color(i) ?? "sky"} waiting={waiting} />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** A due date as a chip: late ones carry the attention tone (on an open issue). */
function DueChip({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  if (!i.dueDate || !isOpen(i)) return null;
  const late = i.dueDate < toYmd(new Date());
  return (
    <Chip icon="calendar" className={cx("issue-due", late && "is-late")}>
      {dueLabel(t, i18n.language, i.dueDate)}
    </Chip>
  );
}

function PriorityChip({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  if (i.priority === "normal") return null;
  return <Chip icon={i.priority === "high" ? "arrowUp" : "dash"}>{t(`issues.priority.${i.priority}`)}</Chip>;
}

function Criteria({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const color = useAssigneeColor();
  if (i.criteria.length === 0) return null;
  const done = i.criteria.filter((c) => c.done).length;
  return (
    <span className="issue-crit" role="img" aria-label={t("issues.criteriaLabel", { done, total: i.criteria.length })}>
      <CriteriaPixels done={i.criteria.map((c) => c.done)} color={color(i)} />
      <span aria-hidden="true">
        {done}/{i.criteria.length}
      </span>
    </span>
  );
}

/** Who has it, or what the agent is doing (the step, "Pede aprovação", "Parado há 2 dias"). */
function WhoLine({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const stepText = useStepText();
  if (!i.assignee) return <span className="issue-who__name muted">{t("issues.noAssignee")}</span>;
  const w = i.work;
  const name = actors.name(i.assignee);
  const avatar =
    i.assignee.type === "agent" ? (
      <AgentAvatar
        agentId={i.assignee.id}
        name={name}
        size="sm"
        running={w?.state === "running"}
        state={w?.state === "running" ? "writing" : undefined}
        expression={isStalled(i) ? "closed" : undefined}
      />
    ) : (
      <ActorAvatar actor={i.assignee} name={name} size="sm" />
    );
  if (w?.state === "stalled")
    return (
      <>
        {avatar}
        <Chip icon="waiting" className="issue-stall">
          {t("issues.work.stalled", { when: relativeTime(t, i18n.language, w.since) })}
        </Chip>
      </>
    );
  if (w?.state === "waiting_approval" || w?.state === "waiting_input")
    return (
      <>
        {avatar}
        <Chip icon="shield" className="issue-needs">
          {t(w.state === "waiting_approval" ? "issues.work.waitingApproval" : "issues.work.waitingInput")}
        </Chip>
      </>
    );
  return (
    <>
      {avatar}
      <span className="issue-who__name">{w ? stepText(w.steps.at(-1)) || t("issues.work.starting") : name}</span>
    </>
  );
}

/** Opens the panel on a plain click; the link still goes to the issue's page (new tab, middle click). */
const panelClick = (e: MouseEvent, open: () => void) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  open();
};

function Board({
  issues,
  openNumber,
  onOpen,
}: {
  issues: Issue[];
  openNumber: number | null;
  onOpen: (n: number) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useIssueAction(org.id);
  const [over, setOver] = useState<IssueStatus | null>(null);
  const move = (number: number, status: IssueStatus) => {
    const issue = issues.find((i) => i.number === number);
    if (!issue || issue.status === status) return;
    const was = issue.status;
    action.mutate(
      { type: "update", id: issue.id, patch: { status } },
      {
        onSuccess: () =>
          toast.show(t("issues.moved", { number, status: t(`issues.status.${status}`) }), "info", {
            label: t("issues.undo"),
            run: () => action.mutate({ type: "update", id: issue.id, patch: { status: was } }),
          }),
      },
    );
  };
  const onDrop = (status: IssueStatus) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const n = Number(e.dataTransfer.getData("text/plain"));
    if (n) move(n, status);
  };
  return (
    <div className="issues-board">
      {BOARD.map((status) => {
        const items = issues.filter((i) => i.status === status);
        return (
          <section
            key={status}
            className={cx("issues-col", over === status && "is-over")}
            aria-label={t(`issues.status.${status}`)}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={onDrop(status)}
          >
            <div className="issues-col__head">
              <Icon name={STATUS_ICON[status]} size={16} />
              <h2>{t(`issues.status.${status}`)}</h2>
              <span className="tabular">{items.length}</span>
            </div>
            <div className="issues-col__cards">
              {items.map((i) => (
                <IssueCard key={i.id} issue={i} selected={i.number === openNumber} onOpen={() => onOpen(i.number)} />
              ))}
              {items.length === 0 && <p className="issues-col__empty">{t("issues.dropHere")}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function IssueCard({ issue: i, selected, onOpen }: { issue: Issue; selected: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const color = useAssigneeColor();
  const pr = i.pullRequests.at(-1);
  return (
    <Link
      to="/org/$orgId/issues/$number"
      params={{ orgId: org.id, number: String(i.number) }}
      className={cx("issue-card", selected && "is-on")}
      aria-label={t("issues.open", { number: i.number, title: i.title })}
      aria-current={selected || undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(i.number));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => panelClick(e, onOpen)}
      data-status={i.status}
    >
      <span className="issue-card__top tabular">
        <span>#{i.number}</span>
        {i.labels[0] && <span>· {i.labels[0]}</span>}
        <span className="issue-card__grow" />
        <PriorityChip issue={i} />
        <DueChip issue={i} />
      </span>
      <span className="issue-card__title">{i.title}</span>
      <Criteria issue={i} />
      <span className="issue-card__foot">
        <WhoLine issue={i} />
        <span className="issue-card__grow" />
        {pr && (
          <Chip icon="pullRequest" className="issue-card__pr">
            {t("issues.pr", { number: pr.number })}
          </Chip>
        )}
      </span>
      {isWorking(i) && <WorkSweep color={color(i) ?? "sky"} waiting={i.work?.state !== "running"} />}
    </Link>
  );
}

function IssueList({
  issues,
  openNumber,
  onOpen,
}: {
  issues: Issue[];
  openNumber: number | null;
  onOpen: (n: number) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const color = useAssigneeColor();
  return (
    <div className="issues-groups">
      {STATUSES.map((status) => {
        const items = issues.filter((i) => i.status === status);
        if (items.length === 0) return null;
        return (
          <section key={status} className="issues-group" aria-label={t(`issues.status.${status}`)}>
            <h2 className="issues-group__title">
              <Icon name={STATUS_ICON[status]} size={16} />
              {t(`issues.status.${status}`)}
              <span>{items.length}</span>
            </h2>
            <ul className="issue-list">
              {items.map((i) => (
                <li key={i.id}>
                  <Link
                    to="/org/$orgId/issues/$number"
                    params={{ orgId: org.id, number: String(i.number) }}
                    className={cx("issue-list__row", i.number === openNumber && "is-on")}
                    onClick={(e) => panelClick(e, () => onOpen(i.number))}
                  >
                    <span className="issue-list__num tabular">#{i.number}</span>
                    <span className="issue-list__title">
                      <b>{i.title}</b>
                      <PriorityChip issue={i} />
                    </span>
                    <span className="issue-list__crit">
                      <Criteria issue={i} />
                    </span>
                    <span className="issue-list__who">
                      <WhoLine issue={i} />
                    </span>
                    <span className="issue-list__due">
                      <DueChip issue={i} />
                    </span>
                    <span className="issue-sr">{t(`issues.status.${i.status}`)}</span>
                    {isWorking(i) && <WorkSweep color={color(i) ?? "sky"} waiting={i.work?.state !== "running"} />}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function NewIssueDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const action = useIssueAction(org.id);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [assignee, setAssignee] = useState(NO_ACTOR);
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [due, setDue] = useState("");
  const dueDate = due.trim() ? parseDayInput(due) : null;
  const dueError = due.trim() !== "" && !dueDate;
  const { criteria } = splitCriteria(text);
  const chosen = actorFromKey(assignee);
  const agent = chosen?.type === "agent" ? actors.dir.agentById.get(chosen.id) : undefined;
  const reset = () => {
    setTitle("");
    setText("");
    setAssignee(NO_ACTOR);
    setPriority("normal");
    setDue("");
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("issues.new")}
      description={t("issues.form.intro")}
      closeLabel={t("common.close")}
      width={560}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || dueError) return;
          const { description, criteria } = splitCriteria(text);
          action.mutate(
            {
              type: "create",
              input: {
                title: title.trim(),
                description,
                criteria,
                assignee: chosen?.type === "person" ? chosen : null,
                priority,
                dueDate,
              },
            },
            {
              onSuccess: (created) => {
                const issue = created as Issue;
                // An agent picked here starts right away ("Pedir"): assigned, its run linked, in progress.
                if (chosen?.type === "agent")
                  action.mutate(
                    { type: "ask", id: issue.id, agentId: chosen.id },
                    {
                      // Couldn't ask (not in a shared channel…): it stays assigned to the agent.
                      onError: () => action.mutate({ type: "update", id: issue.id, patch: { assignee: chosen } }),
                    },
                  );
                toast.show(t("issues.form.created", { number: issue.number }));
                reset();
                onClose();
              },
            },
          );
        }}
      >
        <DialogBody>
          <Field label={t("issues.form.title")} id="ni-title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("issues.form.titlePlaceholder")}
            />
          </Field>
          <Field label={t("issues.form.description")} id="ni-desc" help={t("issues.form.descriptionHelp")}>
            <Textarea
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("issues.form.descriptionPlaceholder")}
            />
          </Field>
          {criteria.length > 0 && (
            <div className="issue-critprev" aria-live="polite">
              <span className="ac-eyebrow">{t("issues.form.criteriaFound", { count: criteria.length })}</span>
              <ul>
                {criteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid-fields">
            <Field label={t("issues.form.assignee")} id="ni-who">
              <Select value={assignee} onValueChange={setAssignee} options={actors.options(true)} />
            </Field>
            <Field label={t("issues.form.priority")} id="ni-pri">
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as IssuePriority)}
                options={PRIORITIES.map((p) => ({ value: p, label: t(`issues.priority.${p}`) }))}
              />
            </Field>
            <Field
              label={t("issues.form.due")}
              id="ni-due"
              help={t("issues.form.dueHelp")}
              error={dueError ? t("issues.form.dueInvalid") : undefined}
            >
              <Input value={due} onChange={(e) => setDue(e.target.value)} inputMode="numeric" placeholder="24/10" />
            </Field>
          </div>
          {agent && (
            <p className="issue-agent-note">
              <Icon name="shield" size={14} />
              {t("issues.form.agentStarts", agentGrammar(t, agent.name))}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("issues.form.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!title.trim() || dueError || action.isPending}
            loading={action.isPending}
          >
            {t("issues.form.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
