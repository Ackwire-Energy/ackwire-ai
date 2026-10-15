import {
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  Input,
  SearchInput,
  Select,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import { useIssueAction, useIssues } from "@/api/queries";
import type { Issue, IssuePriority, IssueStatus } from "@/api/types";
import { ActorLabel, actorFromKey, NO_ACTOR, useActors } from "@/components/actors";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { dueLabel, parseDayInput } from "@/lib/format";
import { useToast } from "@/lib/toast";

export const BOARD: IssueStatus[] = ["todo", "in_progress", "in_review", "done"];
export const STATUSES: IssueStatus[] = [...BOARD, "canceled"];
export const PRIORITIES: IssuePriority[] = ["low", "normal", "high"];
type Filter = "all" | "agents" | "people" | "mine";
const FILTERS: Filter[] = ["all", "agents", "people", "mine"];

/** Description text → description + acceptance criteria (lines starting with "-", "*" or "[ ]"). */
export function splitCriteria(text: string) {
  const criteria: string[] = [];
  const rest: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*]\s*(?:\[[ x]?\]\s*)?|\[[ x]?\]\s*)(.+)$/i);
    if (m?.[1]?.trim()) criteria.push(m[1].trim());
    else rest.push(line);
  }
  return { description: rest.join("\n").trim(), criteria };
}

/** Issues (telas/Issues.dc.html): board by status or a list, search, filters and "Nova issue". */
export function IssuesPage() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const [view, setView] = useState<"board" | "list">("board");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const search = useDeferredValue(q.trim());
  const issues = useIssues(org.id, search);
  const all = issues.data ?? [];
  const pass = (i: Issue) =>
    filter === "all" ||
    (filter === "agents" && i.assignee?.type === "agent") ||
    (filter === "people" && i.assignee?.type === "person") ||
    (filter === "mine" && i.assignee?.type === "person" && i.assignee.id === me.user.id);
  const visible = all.filter(pass);
  const open = all.filter((i) => i.status !== "done" && i.status !== "canceled");
  return (
    <div className="issues-page">
      <header className="issues-page__header">
        <div className="issues-page__title">
          <h1 className="page-title">{t("issues.title")}</h1>
          <span className="small muted">
            {t("issues.summary", {
              open: open.length,
              agents: open.filter((i) => i.assignee?.type === "agent").length,
            })}
          </span>
        </div>
        <SearchInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("issues.search")}
          aria-label={t("issues.search")}
          className="issues-page__search"
        />
        {/* biome-ignore lint/a11y/useSemanticElements: a segmented pair of toggle buttons */}
        <div className="segmented" role="group" aria-label={t("issues.view")}>
          {(["board", "list"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
              {t(`issues.${v}`)}
            </button>
          ))}
        </div>
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          {t("issues.new")}
        </Button>
      </header>
      {/* biome-ignore lint/a11y/useSemanticElements: filter pills */}
      <div className="pills" role="group" aria-label={t("issues.filters")}>
        {FILTERS.map((f) => (
          <button key={f} type="button" className="pill" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`issues.filter.${f}`)}
          </button>
        ))}
      </div>
      {issues.isLoading &&
        (view === "board" ? (
          <div className="issue-board">
            {BOARD.map((status) => (
              <section key={status} className="issue-board__col" aria-label={t(`issues.status.${status}`)}>
                <div className="issue-board__head">
                  <span className="ac-eyebrow">{t(`issues.status.${status}`)}</span>
                </div>
                <LoadingCards count={2} className="loading-cards loading-cards--tight" />
              </section>
            ))}
          </div>
        ) : (
          <div className="issues-page__pad">
            <LoadingList count={5} avatar={false} trailing />
          </div>
        ))}
      {issues.isError && !issues.data && (
        <div className="issues-page__pad">
          <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />
        </div>
      )}
      {issues.isSuccess && all.length === 0 && !search && (
        <div className="issues-page__pad">
          <EmptyState icon="issues">{t("issues.empty")}</EmptyState>
        </div>
      )}
      {issues.isSuccess && visible.length === 0 && (all.length > 0 || search) && (
        <div className="issues-page__pad">
          <EmptyState icon="search">{t("issues.noResults")}</EmptyState>
        </div>
      )}
      {visible.length > 0 && view === "board" && (
        <div className="issue-board">
          {BOARD.map((status) => {
            const items = visible.filter((i) => i.status === status);
            return (
              <section key={status} className="issue-board__col" aria-label={t(`issues.status.${status}`)}>
                <div className="issue-board__head">
                  <span className="ac-eyebrow">{t(`issues.status.${status}`)}</span>
                  <span className="small muted tabular">{items.length}</span>
                </div>
                {items.map((i) => (
                  <IssueCard key={i.id} issue={i} />
                ))}
              </section>
            );
          })}
        </div>
      )}
      {visible.length > 0 && view === "list" && (
        <div className="issues-page__pad">
          <ul className="issue-list">
            {visible.map((i) => (
              <li key={i.id}>
                <Link
                  to="/org/$orgId/issues/$number"
                  params={{ orgId: org.id, number: String(i.number) }}
                  className="issue-list__row"
                >
                  <span className="issue-list__num small muted tabular">#{i.number}</span>
                  <span className="issue-list__title">{i.title}</span>
                  <StatusChip status={i.status} />
                  <span className="issue-list__who small muted">
                    {i.assignee ? <ActorLabel actor={i.assignee} /> : t("issues.noAssignee")}
                  </span>
                  <Due issue={i} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <NewIssueDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

const STATUS_ICON: Record<IssueStatus, "issues" | "waiting" | "checks" | "check" | "close"> = {
  todo: "issues",
  in_progress: "waiting",
  in_review: "checks",
  done: "check",
  canceled: "close",
};

export function StatusChip({ status }: { status: IssueStatus }) {
  const { t } = useTranslation();
  return <Chip icon={STATUS_ICON[status]}>{t(`issues.status.${status}`)}</Chip>;
}

function Due({ issue }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  return (
    <span className="issue-due small muted">{issue.dueDate ? dueLabel(t, i18n.language, issue.dueDate) : ""}</span>
  );
}

function IssueCard({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const pr = i.pullRequests[0];
  return (
    <Link
      to="/org/$orgId/issues/$number"
      params={{ orgId: org.id, number: String(i.number) }}
      className="issue-card"
      aria-label={t("issues.open", { number: i.number, title: i.title })}
    >
      <span className="issue-card__top small muted tabular">
        #{i.number}
        {pr && (
          <span className="issue-card__pr">
            <Icon name="pullRequest" size={16} />
            {t("issues.pr", { number: pr.number })}
          </span>
        )}
        <Due issue={i} />
      </span>
      <span className="issue-card__title">{i.title}</span>
      <span className="issue-card__foot">
        {i.priority === "high" && <Chip icon="arrowUp">{t("issues.priority.high")}</Chip>}
        {i.labels.map((l) => (
          <span key={l} className="ac-chip issue-label">
            {l}
          </span>
        ))}
        <span className="issue-card__who small muted">
          {i.assignee ? <ActorLabel actor={i.assignee} /> : t("issues.noAssignee")}
        </span>
      </span>
    </Link>
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
                assignee: actorFromKey(assignee),
                priority,
                dueDate,
              },
            },
            {
              onSuccess: (created) => {
                toast.show(t("issues.form.created", { number: (created as Issue).number }));
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
