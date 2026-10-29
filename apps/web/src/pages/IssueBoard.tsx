import type { Issue, IssueColumn, IssueStatus } from "@agenteschat/client";
import { keys, useIssueAction, useIssueColumnAction } from "@agenteschat/client";
import {
  Button,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Menu,
  MenuHeading,
  MenuItem,
  MenuNote,
  MenuSeparator,
  OptionList,
} from "@agenteschat/ui";
import { type Query, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type DragEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import {
  BOARD,
  boardStages,
  columnIdOf,
  columnsOf,
  groupByColumn,
  isCustomBoard,
  rankAt,
  STATUS_ICON,
  useColumnTitle,
  useStageName,
} from "@/lib/issues";
import { useToast } from "@/lib/toast";

/** The issue lists in the cache (every search): a move shows in all of them at once. */
const isList = (q: Query) => q.queryKey[3] === "list";

/**
 * Moves an issue to a column at a rank, optimistically (the card lands at
 * once; the server's answer or an error puts the truth back). Says where it
 * went with "Desfazer" when the column changed.
 */
export function useMoveIssue(columns: IssueColumn[]) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const action = useIssueAction(org.id);
  const title = useColumnTitle();
  const stageName = useStageName();
  const custom = isCustomBoard(columns);
  const apply = (issue: Issue, column: IssueColumn, boardRank: number, onDone?: () => void) => {
    const filters = { queryKey: keys.issues(org.id), predicate: isList };
    void qc.cancelQueries(filters);
    const before = qc.getQueriesData<Issue[]>(filters);
    qc.setQueriesData<Issue[]>(filters, (list) =>
      list?.map((i) => (i.id === issue.id ? { ...i, columnId: column.id, status: column.stage, boardRank } : i)),
    );
    action.mutate(
      { type: "update", id: issue.id, patch: { columnId: column.id, boardRank } },
      {
        onError: () => {
          for (const [key, data] of before) qc.setQueryData(key, data);
        },
        onSuccess: onDone,
      },
    );
  };
  return (issue: Issue, column: IssueColumn, boardRank: number) => {
    const fromId = columnIdOf(issue, columns);
    const from = columns.find((c) => c.id === fromId);
    const wasRank = issue.boardRank;
    apply(issue, column, boardRank, () => {
      if (!from || from.id === column.id) return;
      const detail =
        from.stage !== column.stage && custom
          ? t("issues.movedStage", { stage: stageName(column.stage), number: issue.number })
          : t("issues.movedDetail", { number: issue.number, title: issue.title });
      toast.show(
        t("issues.movedTo", { column: title(column) }),
        "info",
        {
          label: t("issues.undo"),
          run: () => apply({ ...issue, columnId: column.id, status: column.stage, boardRank }, from, wasRank),
        },
        detail,
      );
    });
  };
}

interface DragProps {
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}

/**
 * The board: the org's columns, each in a fixed stage.
 * Stage headers group the columns only when the board is customized; cards
 * drag between and inside columns with an insertion line.
 */
export function Board({
  issues,
  columns,
  showCanceled,
  renderCard,
  onNew,
}: {
  issues: Issue[];
  columns: IssueColumn[];
  showCanceled: boolean;
  renderCard: (issue: Issue, drag: DragProps) => ReactNode;
  onNew: (columnId: string) => void;
}) {
  const { t } = useTranslation();
  const stageName = useStageName();
  const title = useColumnTitle();
  const move = useMoveIssue(columns);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<{ col: string; index: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ afterId: string | null } | null>(null);
  const [deleting, setDeleting] = useState<IssueColumn | null>(null);
  const grouped = isCustomBoard(columns);
  const byColumn = groupByColumn(issues, columns);
  const stages = boardStages(columns, showCanceled);

  // Where the card would land: before the first card whose middle is below the pointer.
  const indexAt = (e: DragEvent<HTMLElement>) => {
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-card]")].filter(
      (el) => el.dataset.card !== String(dragging),
    );
    const k = cards.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return k < 0 ? cards.length : k;
  };
  const drop = (col: IssueColumn, index: number, number: number) => {
    const issue = issues.find((i) => i.number === number);
    if (!issue) return;
    const list = byColumn.get(col.id) ?? [];
    const others = list.filter((i) => i.id !== issue.id);
    if (columnIdOf(issue, columns) === col.id && list.indexOf(issue) === index) return;
    move(issue, col, rankAt(others, index));
  };

  return (
    <>
      <div className="issues-boardwrap">
        <div className={cx("issues-board", grouped && "is-grouped")}>
          {stages.map(({ stage, columns: cols }) => (
            <section
              key={stage}
              className="issues-stage"
              style={{ "--n": cols.length } as CSSProperties}
              // A named region only when it groups columns (a plain board names each column).
              aria-label={grouped ? stageName(stage) : undefined}
            >
              {grouped && (
                <div className="issues-stage__head">
                  <Icon name={STATUS_ICON[stage]} size={16} />
                  <h2>{stageName(stage)}</h2>
                  <span>{cols.reduce((n, c) => n + (byColumn.get(c.id)?.length ?? 0), 0)}</span>
                </div>
              )}
              <div className="issues-stage__cols">
                {cols.map((col, k) => {
                  const items = byColumn.get(col.id) ?? [];
                  const others = items.filter((i) => i.number !== dragging);
                  const lineAt = over?.col === col.id ? over.index : null;
                  const line = <div key="line" className="issues-col__line" aria-hidden="true" />;
                  return (
                    <section
                      key={col.id}
                      className={cx(
                        "issues-col",
                        over?.col === col.id && "is-over",
                        col.stage === "canceled" && "is-canceled",
                      )}
                      aria-label={title(col)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const index = indexAt(e);
                        if (over?.col !== col.id || over.index !== index) setOver({ col: col.id, index });
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                          setOver((o) => (o?.col === col.id ? null : o));
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const index = indexAt(e);
                        const n = dragging ?? Number(e.dataTransfer.getData("text/plain"));
                        setOver(null);
                        setDragging(null);
                        if (n) drop(col, index, n);
                      }}
                    >
                      <ColumnHead
                        column={col}
                        siblings={cols}
                        index={k}
                        count={items.length}
                        showIcon={!grouped}
                        renaming={renaming === col.id}
                        onRename={() => setRenaming(col.id)}
                        onRenamed={() => setRenaming(null)}
                        onAddAfter={() => setAdding({ afterId: col.id })}
                        onDelete={() => setDeleting(col)}
                      />
                      <div className="issues-col__cards">
                        {items.map((i) => {
                          const pos = others.indexOf(i);
                          return [
                            lineAt !== null && pos >= 0 && pos === lineAt ? line : null,
                            <div key={i.id} className="issues-col__slot">
                              {renderCard(i, {
                                dragging: dragging === i.number,
                                onDragStart: (e) => {
                                  e.dataTransfer.setData("text/plain", String(i.number));
                                  e.dataTransfer.effectAllowed = "move";
                                  setDragging(i.number);
                                },
                                onDragEnd: () => {
                                  setDragging(null);
                                  setOver(null);
                                },
                              })}
                            </div>,
                          ];
                        })}
                        {lineAt !== null && lineAt >= others.length && line}
                        {items.length === 0 && <p className="issues-col__empty">{t("issues.dropHere")}</p>}
                      </div>
                      {col.stage === "todo" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="plus"
                          block
                          className="issues-col__add"
                          aria-label={t("issues.newIn", { column: title(col) })}
                          onClick={() => onNew(col.id)}
                        >
                          {t("issues.new")}
                        </Button>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
      <AddColumnDialog
        open={adding !== null}
        afterId={adding?.afterId ?? null}
        columns={columns}
        onClose={() => setAdding(null)}
      />
      {deleting && (
        <DeleteColumnDialog column={deleting} columns={columns} issues={issues} onClose={() => setDeleting(null)} />
      )}
    </>
  );
}

/** A column's head: its stage icon (plain board), name (or the rename field), count and "…". */
function ColumnHead({
  column: col,
  siblings,
  index,
  count,
  showIcon,
  renaming,
  onRename,
  onRenamed,
  onAddAfter,
  onDelete,
}: {
  column: IssueColumn;
  siblings: IssueColumn[];
  index: number;
  count: number;
  showIcon: boolean;
  renaming: boolean;
  onRename: () => void;
  onRenamed: () => void;
  onAddAfter: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const title = useColumnTitle();
  const stageName = useStageName();
  const action = useIssueColumnAction(org.id);
  const name = title(col);
  const only = siblings.length === 1;
  const save = (value: string) => {
    onRenamed();
    const v = value.trim();
    if (!v || v === name) return;
    const was = col.name;
    action.mutate(
      { type: "update", columnId: col.id, name: v },
      {
        onSuccess: () =>
          toast.show(
            t("issues.columns.renamed", { name: v }),
            "info",
            // A default column has no name of its own to go back to.
            was
              ? { label: t("issues.undo"), run: () => action.mutate({ type: "update", columnId: col.id, name: was }) }
              : undefined,
          ),
      },
    );
  };
  return (
    <div className="issues-col__head">
      {showIcon && <Icon name={STATUS_ICON[col.stage]} size={16} />}
      {renaming ? (
        <Input
          className="issues-col__rename"
          defaultValue={name}
          maxLength={40}
          aria-label={t("issues.columns.nameLabel")}
          autoComplete="off"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onRenamed();
            }
          }}
          onBlur={(e) => save(e.currentTarget.value)}
        />
      ) : (
        <>
          <h2>{name}</h2>
          <span className="tabular">{count}</span>
          <span className="issues-col__grow" />
          {col.stage !== "canceled" && (
            <Menu
              align="end"
              label={t("issues.columns.options", { name })}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="more"
                  aria-label={t("issues.columns.options", { name })}
                />
              }
            >
              <MenuHeading>{col.name ? `${name} · ${stageName(col.stage)}` : stageName(col.stage)}</MenuHeading>
              {index === 0 && <MenuNote>{t(`issues.columns.entry.${col.stage}`)}</MenuNote>}
              <MenuItem icon="edit" onSelect={onRename}>
                {t("issues.columns.rename")}
              </MenuItem>
              <MenuItem icon="layers" onSelect={onAddAfter}>
                {t("issues.columns.addAfter")}
              </MenuItem>
              <MenuItem
                icon="chevronLeft"
                disabled={index === 0}
                onSelect={() => action.mutate({ type: "update", columnId: col.id, index: index - 1 })}
              >
                {t("issues.columns.moveLeft")}
              </MenuItem>
              <MenuItem
                icon="chevronRight"
                disabled={index === siblings.length - 1}
                onSelect={() => action.mutate({ type: "update", columnId: col.id, index: index + 1 })}
              >
                {t("issues.columns.moveRight")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon="trash" danger disabled={only} onSelect={onDelete}>
                {t("issues.columns.delete")}
              </MenuItem>
              {only && <MenuNote>{t("issues.columns.onlyOne")}</MenuNote>}
            </Menu>
          )}
        </>
      )}
    </div>
  );
}

/** "Nova coluna": a name and one question, the stage. */
export function AddColumnDialog({
  open,
  afterId,
  columns,
  onClose,
}: {
  open: boolean;
  afterId: string | null;
  columns: IssueColumn[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const title = useColumnTitle();
  const stageName = useStageName();
  const action = useIssueColumnAction(org.id);
  const after = afterId ? columns.find((c) => c.id === afterId) : undefined;
  const [name, setName] = useState("");
  const [stage, setStage] = useState<IssueStatus | null>(null);
  // Opening again (another "Adicionar coluna depois"): start from that column's stage.
  const [openedFor, setOpenedFor] = useState<string | null | undefined>(undefined);
  if (open && openedFor !== afterId) {
    setOpenedFor(afterId);
    setName("");
    setStage(after?.stage ?? null);
  }
  if (!open && openedFor !== undefined) setOpenedFor(undefined);
  const where = !stage
    ? t("issues.columns.whereNone")
    : after && after.stage === stage
      ? t("issues.columns.whereAfter", { name: title(after) })
      : t("issues.columns.whereEnd", { stage: stageName(stage) });
  const ready = Boolean(name.trim() && stage);
  const create = () => {
    if (!stage || !name.trim()) return;
    const before = new Set(columns.map((c) => c.id));
    const chosen = stage;
    action.mutate(
      { type: "add", name: name.trim(), stage: chosen, afterId: after?.stage === chosen ? after.id : null },
      {
        onSuccess: (next) => {
          const made = next.find((c) => !before.has(c.id));
          onClose();
          toast.show(
            t("issues.columns.created", { name: name.trim() }),
            "info",
            made
              ? {
                  label: t("issues.undo"),
                  run: () => {
                    const to = columnsOf(next, made.stage).find((c) => c.id !== made.id);
                    if (to) action.mutate({ type: "delete", columnId: made.id, moveTo: to.id });
                  },
                }
              : undefined,
            t("issues.columns.createdDetail", { stage: stageName(chosen) }),
          );
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("issues.columns.newTitle")}
      description={where}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <DialogBody>
          <Field label={t("issues.columns.name")} id="ic-name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              autoComplete="off"
              placeholder={t("issues.columns.namePlaceholder")}
            />
          </Field>
          <div className="issues-stagepick">
            <span className="ac-field__label" id="ic-stage">
              {t("issues.columns.stageQuestion")}
            </span>
            <OptionList
              layout="tiles"
              aria-labelledby="ic-stage"
              value={stage ?? ("" as IssueStatus)}
              onValueChange={setStage}
              options={BOARD.map((s) => ({
                value: s,
                leading: <Icon name={STATUS_ICON[s]} size={16} />,
                title: stageName(s),
                description: t(`issues.columns.stageHint.${s}`),
              }))}
            />
          </div>
          <p className="issues-explain ac-iconline">
            <Icon name="arrowRight" size={16} />
            <span>{t(`issues.columns.stageExplain.${stage ?? "in_progress"}`)}</span>
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("issues.columns.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || action.isPending} loading={action.isPending}>
            {t("issues.columns.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Excluir a coluna X?": where its tasks go, grouped by stage; says when they change stage. */
function DeleteColumnDialog({
  column: col,
  columns,
  issues,
  onClose,
}: {
  column: IssueColumn;
  columns: IssueColumn[];
  issues: Issue[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const title = useColumnTitle();
  const stageName = useStageName();
  const action = useIssueColumnAction(org.id);
  const issueAction = useIssueAction(org.id);
  const others = columns.filter((c) => c.id !== col.id && c.stage !== "canceled");
  const [dest, setDest] = useState(() => columnsOf(others, col.stage)[0]?.id ?? others[0]?.id ?? "");
  // All of its tasks (not only the filtered ones on screen).
  const all = qc.getQueriesData<Issue[]>({ queryKey: keys.issues(org.id), predicate: isList });
  const inIt = [...new Map(all.flatMap(([, list]) => list ?? []).map((i) => [i.id, i])).values()].filter(
    (i) => columnIdOf(i, columns) === col.id,
  );
  const items = inIt.length > 0 ? inIt : issues.filter((i) => columnIdOf(i, columns) === col.id);
  const n = items.length;
  const to = columns.find((c) => c.id === dest);
  const name = title(col);
  const remove = () => {
    if (!to) return;
    const sibling = columnsOf(columns, col.stage);
    const prev = sibling[sibling.indexOf(col) - 1];
    const before = new Set(columns.filter((c) => c.id !== col.id).map((c) => c.id));
    action.mutate(
      { type: "delete", columnId: col.id, moveTo: to.id },
      {
        onSuccess: () => {
          onClose();
          toast.show(
            t("issues.columns.deleted", { name }),
            "info",
            {
              label: t("issues.undo"),
              // Back as it was: the column in its place, its tasks in it again.
              run: () =>
                action.mutate(
                  { type: "add", name, stage: col.stage, afterId: prev?.id ?? null },
                  {
                    onSuccess: (next) => {
                      const made = next.find((c) => !before.has(c.id));
                      if (!made) return;
                      if (!prev) action.mutate({ type: "update", columnId: made.id, index: 0 });
                      for (const i of items)
                        issueAction.mutate({
                          type: "update",
                          id: i.id,
                          patch: { columnId: made.id, boardRank: i.boardRank },
                        });
                    },
                  },
                ),
            },
            n > 0 ? t("issues.columns.deletedDetail", { count: n, name: title(to) }) : undefined,
          );
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("issues.columns.deleteTitle", { name })}
      description={n > 0 ? t("issues.columns.deleteBody", { count: n }) : t("issues.columns.deleteEmpty")}
      closeLabel={t("common.close")}
      width={480}
    >
      {n > 0 && (
        <DialogBody>
          <div className="issues-dests" role="radiogroup" aria-label={t("issues.columns.destinations")}>
            {BOARD.map((s) => {
              const cs = columnsOf(others, s);
              if (cs.length === 0) return null;
              return (
                <div key={s} className="issues-dests__stage">
                  <span>
                    <Icon name={STATUS_ICON[s]} size={14} />
                    {stageName(s)}
                  </span>
                  <div className="issues-dests__row">
                    {cs.map((c) => (
                      // biome-ignore lint/a11y/useSemanticElements: a choice button in a radio group
                      <button
                        key={c.id}
                        type="button"
                        role="radio"
                        aria-checked={dest === c.id}
                        className="issues-dest"
                        onClick={() => setDest(c.id)}
                      >
                        {title(c)}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {to && to.stage !== col.stage && (
            <p className="issues-explain ac-iconline">
              <Icon name="arrowRight" size={16} />
              <span>
                {t("issues.columns.stageChange", {
                  count: n,
                  from: stageName(col.stage),
                  to: stageName(to.stage),
                })}
              </span>
            </p>
          )}
        </DialogBody>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("issues.columns.cancel")}
        </Button>
        <Button
          variant="danger"
          icon="trash"
          disabled={!to || action.isPending}
          loading={action.isPending}
          onClick={remove}
        >
          {n > 0 && to ? t("issues.columns.deleteMove", { name: title(to) }) : t("issues.columns.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
