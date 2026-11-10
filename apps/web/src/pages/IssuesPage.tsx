import type { Actor, Issue, IssueColumn, IssuePriority, IssueStatus, IssuesView } from "@agenteschat/client";
import { useIssueColumns, useIssues, useIssuesView, useSetIssuesView } from "@agenteschat/client";
import { dueLabel, relativeTime, toYmd } from "@agenteschat/client/lib/format";
import { githubLinkLabel } from "@agenteschat/client/lib/github-link";
import { ISSUES_VIEW_DEFAULT, PRIORITY_ORDER, sortIssues } from "@agenteschat/client/lib/issues-view";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Chip,
  CriteriaPixels,
  cx,
  EmptyState,
  GroupHeading,
  Icon,
  Kbd,
  Menu,
  MenuItem,
  PageHeader,
  SearchField,
  Toolbar,
  WorkSweep,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { AskAgentButton } from "@/components/AskAgentButton";
import { actorFromKey, actorKey, NO_ACTOR, useActors } from "@/components/actors";
import { IssueCardWork } from "@/components/BackgroundWork";
import { useFilterCopy } from "@/components/filters";
import { GitHubMark } from "@/components/GitHubMark";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { TaskCardConversation, TaskMentions } from "@/components/TaskConversation";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { copyText } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import {
  BOARD,
  boardStages,
  groupByColumn,
  isCustomBoard,
  isOpen,
  isStalled,
  isWorking,
  rankAt,
  STATUS_ICON,
  useAssigneeColor,
  useColumnTitle,
  useStageName,
  useStepText,
} from "@/lib/issues";
import { lookOf } from "@/lib/look";
import { inPlaceClick } from "@/lib/navigate";
import { useOpenParam } from "@/lib/open-param";
import { type ToastText, useToast } from "@/lib/toast";
import { AddColumnDialog, Board, type CardState, type IssueGroup, useMoveIssue, usePatchIssue } from "./IssueBoard";
import { IssueDeleteProvider, useIssueDeleting } from "./IssueDelete";
import { IssueDialog } from "./IssuePage";
import { DisplayButton, IssueFilters, PRIORITY_ICON } from "./IssuesToolbar";
import { type CardMove, type DropResult, type IssueDrag, useIssueDrag } from "./issue-drag";
import { NewIssueDialog } from "./NewIssueDialog";
import "./issues.css";

export { BOARD, PRIORITIES, STATUSES, splitCriteria } from "@/lib/issues";

export function StatusChip({ status }: { status: IssueStatus }) {
  const { t } = useTranslation();
  return <Chip icon={STATUS_ICON[status]}>{t(`issues.status.${status}`)}</Chip>;
}

/**
 * Tarefas (issues in the code): agents working now, then the tasks as a board or a list, grouped by stage (the org's
 * custom columns in fixed stages), by assignee or by priority, with a details dialog. How the person looks at them
 * (layout, grouping, order, what the cards show, filters) is theirs per workspace, on the server, so every device
 * opens it the same way; the search is not kept.
 */
export function IssuesPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const viewQuery = useIssuesView(org.id);
  const view = viewQuery.data ?? ISSUES_VIEW_DEFAULT;
  const changeView = useSetIssuesView(org.id);
  const [q, setQ] = useState("");
  // The open issue lives in the URL (`?open=131`): a reload or a shared link reopens it.
  const [openParam, setOpenParam] = useOpenParam();
  // A message of the open task's conversation to open at (a notice, a link: ADR 0145).
  const [focusParam] = useOpenParam("m");
  const openNumber = openParam && /^\d+$/.test(openParam) ? Number(openParam) : null;
  const copy = useFilterCopy();
  const searchRef = useRef<HTMLInputElement>(null);
  // "Nova tarefa": false, or open (in a given column of A fazer, or the first).
  const [creating, setCreating] = useState<false | { columnId: string | null }>(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const search = useDeferredValue(q.trim());
  const issues = useIssues(org.id, search);
  const columnsQuery = useIssueColumns(org.id);
  const columns = columnsQuery.data;
  const all = issues.data ?? [];
  const filtered = all.filter(
    (i) =>
      (view.assignees.length === 0 || view.assignees.includes(actorKey(i.assignee))) &&
      (view.priorities.length === 0 || view.priorities.includes(i.priority)),
  );
  const noIssues = issues.isSuccess && all.length === 0 && !search;
  const look = useRightHandLook();
  const posts = can(org, "post");
  const open = all.filter(isOpen);
  const opened = all.find((i) => i.number === openNumber) ?? null;
  const toggle = (n: number) => setOpenParam(openNumber === n ? null : n);
  // The saved view decides the layout: until it comes, the skeleton (not the default board, then the list).
  const viewLoading = viewQuery.isLoading;
  // "N" opens "Nova issue", "/" the search (not while typing or in a dialog; the details dialog closes itself on Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu], [role=listbox]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (posts) setCreating({ columnId: null });
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [posts]);
  return (
    <IssueDeleteProvider onDeleted={() => setOpenParam(null)}>
      <div className="page issues">
        <div className="issues__main">
          <PageHeader
            className="issues-head"
            title={t("issues.title")}
            count={
              <>
                <span>
                  {t("issues.summary", {
                    open: open.length,
                    agents: open.filter((i) => i.assignee?.type === "agent").length,
                  })}
                </span>
                {open.some((i) => !i.assignee) && (
                  <span> · {t("issues.unassigned", { count: open.filter((i) => !i.assignee).length })}</span>
                )}
              </>
            }
            actions={
              // The empty state takes over this button: one way in, in the middle of the page.
              !noIssues &&
              posts && (
                <Button variant="primary" icon="plus" kbd={["N"]} onClick={() => setCreating({ columnId: null })}>
                  {t("issues.new")}
                </Button>
              )
            }
          />
          <WorkingNow issues={all} onOpen={toggle} />
          <Toolbar
            label={t("issues.filters")}
            search={
              <SearchField
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onClear={() => setQ("")}
                clearLabel={copy.clearSearch}
                placeholder={t("issues.search")}
                aria-label={t("issues.search")}
                shortcut={<Kbd aria-hidden="true">/</Kbd>}
              />
            }
            actions={
              <span className="issues-tools">
                <DisplayButton view={view} onChange={changeView} />
                {view.group === "stage" && (
                  <Menu
                    align="end"
                    label={t("issues.moreOptions")}
                    trigger={<Button size="sm" iconOnly icon="more" aria-label={t("issues.moreOptions")} />}
                  >
                    <MenuItem icon="layers" onSelect={() => setAddingColumn(true)} disabled={!columns}>
                      {t("issues.columns.add")}
                    </MenuItem>
                  </Menu>
                )}
              </span>
            }
          >
            <IssueFilters view={view} issues={all} onChange={changeView} />
          </Toolbar>
          {(issues.isLoading || viewLoading || (!columns && columnsQuery.isLoading)) &&
            (view.layout === "board" ? (
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
          {noIssues && (
            <EmptyState
              size="page"
              agent={look}
              title={t(posts ? "issues.emptyTitle" : "issues.emptyViewerTitle")}
              actions={
                posts && (
                  <>
                    <Button variant="primary" icon="plus" onClick={() => setCreating({ columnId: null })}>
                      {t("issues.new")}
                    </Button>
                    <AskAgentButton draft={t("issues.askFirst")} />
                  </>
                )
              }
            >
              {t(posts ? "issues.empty" : "issues.emptyViewer")}
            </EmptyState>
          )}
          {issues.isSuccess && filtered.length === 0 && (all.length > 0 || search) && (
            <EmptyState
              size="panel"
              actions={
                <Button
                  onClick={() => {
                    setQ("");
                    changeView({ assignees: [], priorities: [] });
                  }}
                >
                  {copy.clearAll}
                </Button>
              }
            >
              {t("issues.noResults")}
            </EmptyState>
          )}
          {columnsQuery.isError && !columns && (
            <ErrorState error={columnsQuery.error} onRetry={() => void columnsQuery.refetch()} />
          )}
          {!viewLoading && filtered.length > 0 && columns && (
            <IssuesBody
              view={view}
              columns={columns}
              issues={filtered.filter((i) => view.showCanceled || i.status !== "canceled")}
              all={all}
              openNumber={openNumber}
              onOpen={toggle}
              onNew={(columnId) => setCreating({ columnId })}
            />
          )}
        </div>
        {opened && (
          <IssueDialog issue={opened} focusMessageId={focusParam ?? undefined} onClose={() => setOpenParam(null)} />
        )}
        <NewIssueDialog
          open={creating !== false}
          columnId={creating ? creating.columnId : null}
          columns={columns ?? []}
          onClose={() => setCreating(false)}
        />
        {columns && (
          <AddColumnDialog
            open={addingColumn}
            afterId={null}
            columns={columns}
            onClose={() => setAddingColumn(false)}
          />
        )}
      </div>
    </IssueDeleteProvider>
  );
}

/**
 * The tasks in the view's groups, as a board or a list, and what a drop means in each grouping: by stage the card
 * goes to that column at that place (`useMoveIssue`); by assignee it changes hands, through the same update the
 * task's own assignee field makes; by priority it takes that priority. Each says what happened, with Desfazer.
 */
function IssuesBody({
  view,
  columns,
  issues,
  all,
  openNumber,
  onOpen,
  onNew,
}: {
  view: IssuesView;
  columns: IssueColumn[];
  /** The tasks on screen: filtered, canceled ones only when asked. */
  issues: Issue[];
  /** Every task loaded: who has one gets a column when grouped by assignee. */
  all: Issue[];
  openNumber: number | null;
  onOpen: (n: number) => void;
  onNew: (columnId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const color = useAssigneeColor();
  const title = useColumnTitle();
  const toast = useToast();
  const move = useMoveIssue(columns);
  const patch = usePatchIssue();
  const helpId = useId();
  const stages = boardStages(columns, view.showCanceled);
  const byColumn = groupByColumn(issues, columns);
  // The board's own order, column by column: the order inside an assignee's or a priority's group.
  const reading = new Map<string, number>();
  for (const { columns: cols } of boardStages(columns, true))
    for (const c of cols) for (const i of byColumn.get(c.id) ?? []) reading.set(i.id, reading.size);
  const byReading = (a: Issue, b: Issue) => (reading.get(a.id) ?? 0) - (reading.get(b.id) ?? 0);
  const inOrder = (list: Issue[]) => sortIssues([...list].sort(byReading), view.sort);

  const groups: IssueGroup[] = [];
  if (view.group === "stage") {
    for (const { stage, columns: cols } of stages) {
      for (const c of cols) {
        groups.push({
          id: c.id,
          name: title(c),
          items: sortIssues(byColumn.get(c.id) ?? [], view.sort),
          lead: <Icon name={STATUS_ICON[stage]} size={16} />,
          dropText: t("issues.drop.stage", { name: title(c) }),
        });
      }
    }
  } else if (view.group === "assignee") {
    // Everyone with a task here (and anyone the filter names), by name; "Sem responsável" last.
    const keys = new Set([
      ...all.filter((i) => view.showCanceled || i.status !== "canceled").map((i) => actorKey(i.assignee)),
      ...view.assignees,
    ]);
    keys.delete(NO_ACTOR);
    const people = [...keys]
      .map((k) => actorFromKey(k))
      .filter((a): a is Actor => a !== null)
      .map((a) => ({ actor: a, name: actors.name(a) }))
      .sort((a, b) => a.name.localeCompare(b.name, i18n.language));
    for (const { actor, name } of people) {
      groups.push({
        id: actorKey(actor),
        name,
        items: inOrder(issues.filter((i) => actorKey(i.assignee) === actorKey(actor))),
        lead: <ActorAvatar actor={actor} name={name} size="xs" />,
        dropText: t("issues.drop.assignee", { name }),
      });
    }
    groups.push({
      id: NO_ACTOR,
      name: t("issues.noAssignee"),
      items: inOrder(issues.filter((i) => !i.assignee)),
      lead: <Icon name="person" size={16} />,
      dropText: t("issues.drop.unassign"),
    });
  } else {
    for (const p of PRIORITY_ORDER) {
      groups.push({
        id: p,
        name: t(`issues.priority.${p}`),
        items: inOrder(issues.filter((i) => i.priority === p)),
        lead: <Icon name={PRIORITY_ICON[p]} size={16} />,
        dropText: t("issues.drop.priority", { priority: t(`issues.priorityLower.${p}`) }),
      });
    }
  }

  const undo = (run: () => void) => ({ label: t("issues.undo"), run });
  // An agent named in the toast shows its face before its name.
  const assignedText = (issue: Issue, to: Actor | null): ToastText => {
    if (!to) return t("issues.drag.unassigned", { number: issue.number });
    const name = actors.name(to);
    const text = t("issues.drag.assigned", { number: issue.number, name });
    return to.type === "agent" ? { text, who: { name, appearance: lookOf(actors.dir.agentById.get(to.id)) } } : text;
  };
  const reassign = (issue: Issue, to: Actor | null) => {
    const was = issue.assignee;
    const back = () => patch({ ...issue, assignee: to }, { assignee: was }, { assignee: was });
    patch(issue, { assignee: to }, { assignee: to }, () => toast.show(assignedText(issue, to), "info", undo(back)));
  };
  const prioritize = (issue: Issue, priority: IssuePriority) => {
    const was = issue.priority;
    const back = () => patch({ ...issue, priority }, { priority: was }, { priority: was });
    const text = t("issues.drag.prioritized", {
      number: issue.number,
      priority: t(`issues.priorityLower.${priority}`),
    });
    patch(issue, { priority }, { priority }, () => toast.show(text, "info", undo(back)));
  };
  const onDrop = ({ id, from, to, index }: CardMove): DropResult => {
    const issue = issues.find((i) => i.id === id);
    if (!issue) return { changed: false };
    if (view.group === "stage") {
      const column = columns.find((c) => c.id === to);
      // Sorted by priority or due date, a column's order isn't the person's to change.
      if (!column || (view.sort !== "manual" && from === to)) return { changed: false };
      const others = (byColumn.get(to) ?? []).filter((i) => i.id !== id);
      move(issue, column, view.sort === "manual" ? rankAt(others, index) : rankAt(others, 0));
      const done = column.stage === "done" && issue.status !== "done";
      return done ? { changed: true, burst: color(issue) } : { changed: true };
    }
    if (from === to) return { changed: false };
    if (view.group === "assignee") reassign(issue, actorFromKey(to));
    else prioritize(issue, to as IssuePriority);
    return { changed: true };
  };
  const nameOf = (group: string) => groups.find((g) => g.id === group)?.name ?? "";
  const dnd = useIssueDrag<Issue>({
    groups,
    layout: view.layout,
    onDrop,
    words: {
      picked: (i) => t("issues.drag.picked", { number: i.number }),
      moved: (i, group, position, total) =>
        t("issues.drag.moved", { number: i.number, group: nameOf(group), position, total }),
      dropped: (i, group) => t("issues.drag.dropped", { number: i.number, group: nameOf(group) }),
      canceled: (i) => t("issues.drag.canceled", { number: i.number }),
    },
  });
  const renderCard = (i: Issue, group: string, state: CardState) => (
    <IssueCard
      issue={i}
      selected={i.number === openNumber}
      onOpen={() => onOpen(i.number)}
      drag={{ ...dnd.card(i, group), help: helpId }}
      picked={state === "picked"}
      fields={view.fields}
    />
  );
  return (
    <div ref={dnd.root} className="issues-body">
      <p id={helpId} className="ac-visually-hidden">
        {t("issues.drag.help")}
      </p>
      <p className="ac-visually-hidden" aria-live="assertive">
        {dnd.live}
      </p>
      {view.layout === "board" ? (
        <Board
          groups={groups}
          stages={view.group === "stage" ? stages : null}
          columns={columns}
          dnd={dnd}
          renderCard={renderCard}
          onNew={onNew}
        />
      ) : (
        <IssueList
          groups={groups}
          stages={view.group === "stage" ? stages : null}
          columns={columns}
          dnd={dnd}
          openNumber={openNumber}
          onOpen={onOpen}
          fields={view.fields}
          helpId={helpId}
        />
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
              className={cx("issues-now__card ac-mediarow", stall && "is-stalled", waiting && "is-waiting")}
              onClick={() => onOpen(i.number)}
            >
              <span className="ac-mediarow__face">
                <AgentAvatar
                  agentId={i.assignee.id}
                  name={name}
                  size="md"
                  state={stall ? "idle" : waiting ? "idle" : "writing"}
                  running={!stall && !waiting}
                  expression={stall ? "closed" : undefined}
                />
              </span>
              <span className="ac-mediarow__head">
                <b>{name}</b>
                <span className="ac-mediarow__meta">
                  #{i.number} ·{" "}
                  {stall
                    ? t("issues.work.stalled", { when: relativeTime(t, i18n.language, w.since) })
                    : relativeTime(t, i18n.language, w.since)}
                </span>
              </span>
              <span className="ac-mediarow__body">
                <span className="issues-now__task">{i.title}</span>
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

/**
 * Who has it, or what the agent is doing (the step, "Pede aprovação", "Parado há 2 dias"). Nobody: an empty place the
 * size of a face, so the name lines up with the cards that have one.
 */
function WhoLine({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const stepText = useStepText();
  if (!i.assignee)
    return (
      <>
        <span className="issue-nobody" aria-hidden="true">
          <Icon name="person" size={14} />
        </span>
        <span className="issue-who__name muted">{t("issues.noAssignee")}</span>
      </>
    );
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

/** An issue's right click (board card, list row): open beside the list, open its page, copy its link, delete it. */
function useIssueMenu() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const { ask, mayDelete } = useIssueDeleting();
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
      ...(mayDelete(i)
        ? ([
            { kind: "separator" },
            {
              kind: "item",
              id: "delete",
              label: t("issues.delete.action"),
              icon: "trash",
              danger: true,
              run: () => ask(i),
            },
          ] as const)
        : []),
    ]);
}

/** What a card takes to move: the pointer and keyboard handlers, and the line that says how. */
type CardDrag = ReturnType<IssueDrag<Issue>["card"]> & { help: string };

/** A card's or a row's own keys first (the menu key), then Space picks it up. */
function withMenuKeys(menu: ReturnType<ReturnType<typeof useIssueMenu>>, drag: CardDrag) {
  return (e: Parameters<CardDrag["onKeyDown"]>[0]) => {
    menu.onKeyDown(e);
    drag.onKeyDown(e);
  };
}

/** The task's GitHub link on its row: the row opens the task, the page opens the link. */
function GithubChip({ url }: { url: string }) {
  return (
    <Chip lead={<GitHubMark />} className="issue-card__pr" title={url}>
      {githubLinkLabel(url)}
    </Chip>
  );
}

function IssueCard({
  issue: i,
  selected,
  onOpen,
  drag,
  picked,
  fields,
}: {
  issue: Issue;
  selected: boolean;
  onOpen: () => void;
  drag: CardDrag;
  picked: boolean;
  fields: IssuesView["fields"];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const color = useAssigneeColor();
  const pr = fields.pullRequest ? i.pullRequests.at(-1) : undefined;
  const github = fields.pullRequest ? i.githubUrl : null;
  const menu = useIssueMenu()(i, () => !selected && onOpen());
  return (
    <Link
      to="/org/$orgId/issues/$number"
      params={{ orgId: org.id, number: String(i.number) }}
      className={cx("issue-card", selected && "is-on", picked && "is-picked")}
      aria-label={t("issues.open", { number: i.number, title: i.title })}
      aria-current={selected || undefined}
      aria-roledescription={t("issues.drag.role")}
      aria-describedby={drag.help}
      draggable={drag.draggable}
      onDragStart={drag.onDragStart}
      onPointerDown={drag.onPointerDown}
      onClick={(e) => inPlaceClick(e, onOpen)}
      onContextMenu={menu.onContextMenu}
      onKeyDown={withMenuKeys(menu, drag)}
      data-status={i.status}
      data-card={i.number}
    >
      <span className="issue-card__title">
        <span className="issue-card__number tabular">#{i.number}</span> {i.title}
        <TaskMentions issue={i} />
      </span>
      {((fields.label && i.labels[0]) ||
        (fields.priority && i.priority !== "normal") ||
        (fields.due && i.dueDate && isOpen(i))) && (
        <span className="issue-card__top tabular">
          {fields.label && i.labels[0] && <span>{i.labels[0]}</span>}
          <span className="issue-card__grow" />
          {fields.priority && <PriorityChip issue={i} />}
          {fields.due && <DueChip issue={i} />}
        </span>
      )}
      {fields.criteria && <Criteria issue={i} />}
      <IssueCardWork issue={i} />
      {(fields.assignee || pr || github) && (
        <span className="issue-card__foot">
          {fields.assignee && <WhoLine issue={i} />}
          <span className="issue-card__grow" />
          {github && <GithubChip url={github} />}
          {pr && (
            <Chip icon="pullRequest" className="issue-card__pr">
              {t("issues.pr", { number: pr.number })}
            </Chip>
          )}
        </span>
      )}
      <TaskCardConversation issue={i} />
      {isWorking(i) && <WorkSweep color={color(i) ?? "sky"} waiting={i.work?.state !== "running"} />}
    </Link>
  );
}

/**
 * The list. Grouped by stage: each stage, then its columns when the board is customized. Otherwise one group per
 * assignee or priority. A group with nothing in it shows only while a card moves, so there is somewhere to drop it.
 */
function IssueList({
  groups,
  stages,
  columns,
  dnd,
  openNumber,
  onOpen,
  fields,
  helpId,
}: {
  groups: IssueGroup[];
  stages: { stage: IssueStatus; columns: IssueColumn[] }[] | null;
  columns: IssueColumn[];
  dnd: IssueDrag<Issue>;
  openNumber: number | null;
  onOpen: (n: number) => void;
  fields: IssuesView["fields"];
  helpId: string;
}) {
  const stageName = useStageName();
  const title = useColumnTitle();
  const custom = isCustomBoard(columns);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const zone = (g: IssueGroup, heading?: ReactNode) => (
    <div key={g.id} className={cx("issues-group__col", dnd.over === g.id && "is-over")} data-col>
      {heading}
      <IssueRows group={g} dnd={dnd} openNumber={openNumber} onOpen={onOpen} fields={fields} helpId={helpId} />
    </div>
  );
  if (stages)
    return (
      <div className="ac-groups">
        {stages.map(({ stage, columns: cols }) => {
          const count = cols.reduce((n, c) => n + dnd.count(c.id), 0);
          if (count === 0 && !dnd.active) return null;
          return (
            <section key={stage} className="issues-group" aria-label={stageName(stage)}>
              <GroupHeading
                title={
                  <>
                    <Icon name={STATUS_ICON[stage]} size={16} />
                    {stageName(stage)}
                  </>
                }
                count={
                  <span className="tabular" data-count={custom ? undefined : cols[0]?.id}>
                    {count}
                  </span>
                }
              />
              {cols.map((c) => {
                const g = byId.get(c.id);
                if (!g || (dnd.count(c.id) === 0 && !dnd.active)) return null;
                return zone(
                  g,
                  custom && stage !== "canceled" && (
                    <GroupHeading
                      level={3}
                      title={title(c)}
                      count={
                        <span className="tabular" data-count={c.id}>
                          {dnd.count(c.id)}
                        </span>
                      }
                    />
                  ),
                );
              })}
            </section>
          );
        })}
      </div>
    );
  return (
    <div className="ac-groups">
      {groups.map((g) => {
        const count = dnd.count(g.id);
        if (count === 0 && !dnd.active) return null;
        return (
          <section key={g.id} className="issues-group" aria-label={g.name}>
            <GroupHeading
              title={
                <>
                  {g.lead}
                  {g.name}
                </>
              }
              count={
                <span className="tabular" data-count={g.id}>
                  {count}
                </span>
              }
            />
            {zone(g)}
          </section>
        );
      })}
    </div>
  );
}

function IssueRows({
  group: g,
  dnd,
  openNumber,
  onOpen,
  fields,
  helpId,
}: {
  group: IssueGroup;
  dnd: IssueDrag<Issue>;
  openNumber: number | null;
  onOpen: (n: number) => void;
  fields: IssuesView["fields"];
  helpId: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const color = useAssigneeColor();
  const menuOf = useIssueMenu();
  const entries = dnd.entries(g.id);
  const shown = entries.some((e) => e.kind === "spot" || e.state !== "hidden");
  return (
    <ul className="issue-list" data-drop={g.id}>
      {entries.map((e) => {
        if (e.kind === "spot")
          return <li key={e.key} className="issue-spot issue-spot--row" data-spot style={e.style} aria-hidden="true" />;
        const i = e.item;
        const menu = menuOf(i, () => i.number !== openNumber && onOpen(i.number));
        const drag = { ...dnd.card(i, g.id), help: helpId };
        return (
          <li
            key={i.id}
            data-slot={i.id}
            hidden={e.state === "hidden" || undefined}
            data-landing={e.state === "landing" || undefined}
          >
            <Link
              to="/org/$orgId/issues/$number"
              params={{ orgId: org.id, number: String(i.number) }}
              className={cx("issue-list__row", i.number === openNumber && "is-on", e.state === "picked" && "is-picked")}
              aria-roledescription={t("issues.drag.role")}
              aria-describedby={drag.help}
              draggable={drag.draggable}
              onDragStart={drag.onDragStart}
              onPointerDown={drag.onPointerDown}
              onClick={(ev) => inPlaceClick(ev, () => onOpen(i.number))}
              onContextMenu={menu.onContextMenu}
              onKeyDown={withMenuKeys(menu, drag)}
              data-card={i.number}
            >
              <span className="issue-list__num tabular">#{i.number}</span>
              <span className="issue-list__title">
                <b data-num={`#${i.number}`}>{i.title}</b>
                <TaskMentions issue={i} />
                {fields.priority && <PriorityChip issue={i} />}
                {fields.pullRequest && i.githubUrl && <GithubChip url={i.githubUrl} />}
              </span>
              <span className="issue-list__crit">{fields.criteria && <Criteria issue={i} />}</span>
              <span className="issue-list__who">{fields.assignee && <WhoLine issue={i} />}</span>
              <span className="issue-list__due">{fields.due && <DueChip issue={i} />}</span>
              <span className="issue-sr">{t(`issues.status.${i.status}`)}</span>
              {isWorking(i) && <WorkSweep color={color(i) ?? "sky"} waiting={i.work?.state !== "running"} />}
            </Link>
          </li>
        );
      })}
      {!shown && dnd.active && (
        <li className="issue-list__drop" aria-hidden="true">
          {g.dropText}
        </li>
      )}
    </ul>
  );
}
