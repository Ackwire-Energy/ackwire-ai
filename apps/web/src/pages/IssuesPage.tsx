import type { Issue, IssueColumn, IssuePriority, IssueStatus } from "@agenteschat/client";
import { useIssueAction, useIssueColumns, useIssues } from "@agenteschat/client";
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
  Icon,
  Input,
  Menu,
  MenuCheckboxItem,
  MenuItem,
  SearchField,
  Segmented,
  Select,
  Textarea,
  Toolbar,
  WorkSweep,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type DragEvent, useDeferredValue, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { actorFromKey, NO_ACTOR, useActors } from "@/components/actors";
import { useActorFilterOptions, useFilterCopy } from "@/components/filters";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { copyText } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import {
  BOARD,
  columnIdOf,
  columnsOf,
  groupByColumn,
  isCustomBoard,
  isOpen,
  isStalled,
  isWorking,
  PRIORITIES,
  STATUS_ICON,
  STATUSES,
  splitCriteria,
  useAssigneeColor,
  useColumnTitle,
  useStageName,
  useStepText,
} from "@/lib/issues";
import { inPlaceClick } from "@/lib/navigate";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import { AddColumnDialog, Board } from "./IssueBoard";
import { IssueDialog } from "./IssuePage";
import "./issues.css";

export { BOARD, PRIORITIES, STATUSES, splitCriteria } from "@/lib/issues";

type Filter = "all" | "agents" | "people" | "mine" | "none";
const FILTERS: Filter[] = ["all", "agents", "people", "mine", "none"];

export function StatusChip({ status }: { status: IssueStatus }) {
  const { t } = useTranslation();
  return <Chip icon={STATUS_ICON[status]}>{t(`issues.status.${status}`)}</Chip>;
}

/**
 * Tarefas (issues in the code): agents working now, the
 * org's board (custom columns in fixed stages, drag between and inside them)
 * or a list, a details panel.
 */
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
  // "Nova tarefa": false, or open (in a given column of A fazer, or the first).
  const [creating, setCreating] = useState<false | { columnId: string | null }>(false);
  const [showCanceled, setShowCanceled] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const search = useDeferredValue(q.trim());
  const issues = useIssues(org.id, search);
  const columnsQuery = useIssueColumns(org.id);
  const columns = columnsQuery.data;
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
        setCreating({ columnId: null });
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
          <Button variant="primary" icon="plus" kbd={["N"]} onClick={() => setCreating({ columnId: null })}>
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
            <span className="issues-tools">
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
              <Menu
                align="end"
                label={t("issues.moreOptions")}
                trigger={<Button size="sm" iconOnly icon="more" aria-label={t("issues.moreOptions")} />}
              >
                <MenuItem icon="layers" onSelect={() => setAddingColumn(true)} disabled={!columns}>
                  {t("issues.columns.add")}
                </MenuItem>
                <MenuCheckboxItem
                  checked={showCanceled}
                  onCheckedChange={setShowCanceled}
                  hint={all.filter((i) => i.status === "canceled").length}
                >
                  {t("issues.showCanceled")}
                </MenuCheckboxItem>
              </Menu>
            </span>
          }
        >
          <Segmented
            label={t("issues.filters")}
            value={filter}
            onValueChange={setFilter}
            options={FILTERS.map((f) => ({
              value: f,
              label: t(`issues.filter.${f}`),
              count: all.filter((i) => isOpen(i) && pass(i, f)).length,
            }))}
          />
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
        {(issues.isLoading || (view === "board" && !columns && columnsQuery.isLoading)) &&
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
              <Button variant="primary" icon="plus" onClick={() => setCreating({ columnId: null })}>
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
        {columnsQuery.isError && !columns && (
          <ErrorState error={columnsQuery.error} onRetry={() => void columnsQuery.refetch()} />
        )}
        {visible.length > 0 && view === "board" && columns && (
          <Board
            issues={visible.filter((i) => showCanceled || i.status !== "canceled")}
            columns={columns}
            showCanceled={showCanceled}
            onNew={(columnId) => setCreating({ columnId })}
            renderCard={(i, drag) => (
              <IssueCard issue={i} selected={i.number === openNumber} onOpen={() => toggle(i.number)} drag={drag} />
            )}
          />
        )}
        {visible.length > 0 && view === "list" && columns && (
          <IssueList
            issues={visible.filter((i) => showCanceled || i.status !== "canceled")}
            columns={columns}
            openNumber={openNumber}
            onOpen={toggle}
          />
        )}
      </div>
      {opened && <IssueDialog issue={opened} onClose={() => setOpenParam(null)} />}
      <NewIssueDialog
        open={creating !== false}
        columnId={creating ? creating.columnId : null}
        columns={columns ?? []}
        onClose={() => setCreating(false)}
      />
      {columns && (
        <AddColumnDialog open={addingColumn} afterId={null} columns={columns} onClose={() => setAddingColumn(false)} />
      )}
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

/** An issue's right click (board card, list row): open beside the list, open its page, copy its link. */
function useIssueMenu() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  return (i: Issue, onOpen: () => void) =>
    entityMenu(() => [
      { kind: "header", label: `#${i.number} ${i.title}` },
      { kind: "item", id: "open", label: t("contextMenu.open"), icon: "arrowRight", run: onOpen },
      {
        kind: "item",
        id: "open-page",
        label: t("contextMenu.openPage"),
        icon: "expand",
        run: () =>
          void navigate({ to: "/org/$orgId/issues/$number", params: { orgId: org.id, number: String(i.number) } }),
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "copy-link",
        label: t("contextMenu.copyLink"),
        icon: "link",
        run: () =>
          void copyText(`${window.location.origin}/org/${org.id}/issues/${i.number}`, () =>
            toast.show(t("contextMenu.linkCopied")),
          ),
      },
    ]);
}

function IssueCard({
  issue: i,
  selected,
  onOpen,
  drag,
}: {
  issue: Issue;
  selected: boolean;
  onOpen: () => void;
  drag: { dragging: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void };
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const color = useAssigneeColor();
  const pr = i.pullRequests.at(-1);
  const menu = useIssueMenu();
  return (
    <Link
      to="/org/$orgId/issues/$number"
      params={{ orgId: org.id, number: String(i.number) }}
      className={cx("issue-card", selected && "is-on", drag.dragging && "is-dragging")}
      aria-label={t("issues.open", { number: i.number, title: i.title })}
      aria-current={selected || undefined}
      draggable
      onDragStart={drag.onDragStart}
      onDragEnd={drag.onDragEnd}
      onClick={(e) => inPlaceClick(e, onOpen)}
      {...menu(i, () => !selected && onOpen())}
      data-status={i.status}
      data-card={i.number}
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

/** The list: grouped by stage, then by column when the board is customized. */
function IssueList({
  issues,
  columns,
  openNumber,
  onOpen,
}: {
  issues: Issue[];
  columns: IssueColumn[];
  openNumber: number | null;
  onOpen: (n: number) => void;
}) {
  const stageName = useStageName();
  const title = useColumnTitle();
  const custom = isCustomBoard(columns);
  const byColumn = groupByColumn(issues, columns);
  return (
    <div className="issues-groups">
      {STATUSES.map((status) => {
        const cols = columnsOf(columns, status);
        const count = cols.reduce((n, c) => n + (byColumn.get(c.id)?.length ?? 0), 0);
        if (count === 0) return null;
        return (
          <section key={status} className="issues-group" aria-label={stageName(status)}>
            <h2 className="issues-group__title">
              <Icon name={STATUS_ICON[status]} size={16} />
              {stageName(status)}
              <span>{count}</span>
            </h2>
            {cols.map((c) => {
              const items = byColumn.get(c.id) ?? [];
              if (items.length === 0) return null;
              return (
                <div key={c.id} className="issues-group__col">
                  {custom && status !== "canceled" && (
                    <h3 className="issues-group__sub">
                      {title(c)}
                      <span>{items.length}</span>
                    </h3>
                  )}
                  <IssueRows issues={items} openNumber={openNumber} onOpen={onOpen} />
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function IssueRows({
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
  const menu = useIssueMenu();
  return (
    <ul className="issue-list">
      {issues.map((i) => (
        <li key={i.id}>
          <Link
            to="/org/$orgId/issues/$number"
            params={{ orgId: org.id, number: String(i.number) }}
            className={cx("issue-list__row", i.number === openNumber && "is-on")}
            onClick={(e) => inPlaceClick(e, () => onOpen(i.number))}
            {...menu(i, () => i.number !== openNumber && onOpen(i.number))}
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
  );
}

function NewIssueDialog({
  open,
  columnId,
  columns,
  onClose,
}: {
  open: boolean;
  /** The column of A fazer it was asked from ("Nova tarefa" under a column); else the first. */
  columnId: string | null;
  columns: IssueColumn[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const title_ = useColumnTitle();
  const todoColumns = columnsOf(columns, "todo");
  const [column, setColumn] = useState<string | null>(null);
  const [openedWith, setOpenedWith] = useState<string | null | undefined>(undefined);
  if (open && openedWith !== columnId) {
    setOpenedWith(columnId);
    setColumn(columnId);
  }
  if (!open && openedWith !== undefined) setOpenedWith(undefined);
  const chosenColumn = todoColumns.find((c) => c.id === column) ?? todoColumns[0];
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
                // New tasks land in the first column of A fazer; another one was chosen.
                if (chosenColumn && chosenColumn.id !== columnIdOf(issue, columns) && chosen?.type !== "agent")
                  action.mutate({ type: "update", id: issue.id, patch: { columnId: chosenColumn.id } });
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
          {todoColumns.length > 1 && (
            <Field label={t("issues.column")} id="ni-col">
              <Select
                value={chosenColumn?.id}
                onValueChange={setColumn}
                options={todoColumns.map((c) => ({ value: c.id, label: title_(c) }))}
              />
            </Field>
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
            <p className="issue-agent-note ac-iconline">
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
