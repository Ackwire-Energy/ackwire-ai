import {
  Avatar,
  Button,
  Card,
  Chip,
  Dialog,
  DialogFooter,
  Icon,
  type IconName,
  List,
  SearchInput,
} from "@agenteschat/ui";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useAgents } from "@/api/queries";
import type { AccessState, Agent, AgentAccess } from "@/api/types";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useAreaLabel } from "@/hooks/useAreaLabel";
import { useDirectory } from "@/hooks/useDirectory";
import {
  type AccessModel,
  type AccessNode,
  countTools,
  cycleTool,
  isOn,
  modelFrom,
  type ResolvedNode,
  resolve,
  toInput,
  treeFromAccess,
} from "@/lib/access";
import { can } from "@/lib/permissions";
import { useToast } from "@/lib/toast";
import { PermissionsDialog } from "@/pages/AgentPage";

/** Inherited is a muted check (with a tooltip saying where it comes from), never a look-alike icon. */
export const STATE_ICON: Record<AccessState | "partial", IconName> = {
  granted: "check",
  inherited: "check",
  denied: "block",
  off: "dash",
  partial: "dash",
};

/** A group's cell: every tool on, none, or some. */
export function groupState(states: AccessState[]): AccessState | "partial" {
  const on = states.filter(isOn);
  if (on.length === states.length) return states.includes("granted") ? "granted" : "inherited";
  if (on.length === 0) return states.includes("denied") ? "denied" : "off";
  return "partial";
}

/** Tool states by id, for counting staged changes. */
function statesOf(resolved: ResolvedNode[]) {
  const out = new Map<string, AccessState>();
  for (const g of resolved) for (const t of g.children) out.set(t.id, t.state);
  return out;
}

/** How many tool cells differ between two models of the same tree. */
export function changedCells(tree: AccessNode[], a: AccessModel, b: AccessModel) {
  const x = statesOf(resolve(tree, a));
  const y = statesOf(resolve(tree, b));
  let n = 0;
  for (const [id, s] of x) if (y.get(id) !== s) n++;
  return n;
}

/** Every agent's access, read once per agent (the list and the matrix share it). */
function useAllAccess(agents: Agent[], enabled: boolean) {
  const api = useApi();
  const { org } = useOrg();
  return useQueries({
    queries: agents.map((a) => ({
      queryKey: keys.agentAccess(org.id, a.id),
      queryFn: () => api.access.get(org.id, a.id),
      enabled,
      retry: false,
    })),
  });
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Settings → "Agentes e acesso" (admins): one row per agent with a short
 * summary and "Editar" (the agent's "Editar permissões"); "Ver todas as
 * permissões" opens the matrix in a large dialog.
 */
export function AccessMatrixSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const admin = can(org.role, "configure");
  const agents = useAgents(org.id);
  const list = agents.data ?? [];
  const access = useAllAccess(list, admin);
  const areaLabel = useAreaLabel();
  const [editing, setEditing] = useState<Agent | null>(null);
  const [matrix, setMatrix] = useState(false);
  if (!admin) return null;
  const unavailable = access.some((q) => (q.error as { status?: number } | null)?.status === 404);

  const summary = (a: AccessAgentRow) => {
    if (!a.access) return null;
    const tree = treeFromAccess(a.access, areaLabel);
    const resolved = resolve(tree, modelFrom(a.access));
    const count = countTools(resolved);
    const blocked = resolved.flatMap((g) => g.children).filter((x) => x.state === "denied").length;
    const groups = resolved.filter((g) => g.children.some((x) => isOn(x.state)) && !g.locked).map((g) => g.label);
    const text = a.access.all
      ? t("access.summaryAll")
      : count.on === 0
        ? t("access.summaryNone")
        : t("access.summaryCount", {
            on: count.on,
            total: count.total,
            groups: groups.slice(0, 3).join(", "),
          });
    return { text, blocked };
  };

  return (
    <Card aria-labelledby="sec-access">
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-4" style={{ flex: "1 1 280px", gap: 2 }}>
          <h2 id="sec-access" className="ac-card__title">
            {t("access.matrixTitle")}
          </h2>
          <span className="small muted">{t("access.listSubtitle")}</span>
        </div>
        {!unavailable && list.length > 0 && (
          <Button variant="primary" size="sm" onClick={() => setMatrix(true)}>
            {t("access.seeAll")}
          </Button>
        )}
      </div>
      {unavailable && <p className="small muted">{t("access.unavailable")}</p>}
      {(agents.isLoading || (list.length > 0 && access.some((q) => q.isLoading) && !unavailable)) && (
        <LoadingList count={Math.min(Math.max(list.length, 2), 5)} trailing />
      )}
      {agents.isSuccess && list.length === 0 && <p className="small muted">{t("access.noAgents")}</p>}
      {!unavailable && list.length > 0 && !access.some((q) => q.isLoading) && (
        <List aria-label={t("access.matrixTitle")}>
          {list.map((a, i) => {
            const s = summary({ agent: a, access: access[i]?.data });
            return (
              <div key={a.id} className="ac-list__row access-agent">
                <Avatar kind="agent" size="sm" name={a.name} initials={dir.agentInitials(a.id)} />
                <span className="list-col" style={{ flex: "1 1 240px" }}>
                  <span style={{ fontWeight: 600 }}>
                    {a.name}
                    {a.role && <span className="muted"> · {a.role}</span>}
                  </span>
                  <span className="small muted">{s?.text ?? t("common.loading")}</span>
                </span>
                {s && s.blocked > 0 && <Chip icon="block">{t("access.blockedCount", { count: s.blocked })}</Chip>}
                <Button size="sm" aria-label={t("access.editAgent", { name: a.name })} onClick={() => setEditing(a)}>
                  {t("agent.edit")}
                </Button>
              </div>
            );
          })}
        </List>
      )}
      {editing && <PermissionsDialog open onOpenChange={(o) => !o && setEditing(null)} agent={editing} />}
      <AccessMatrixDialog
        open={matrix}
        onClose={() => setMatrix(false)}
        agents={list}
        access={access.map((q) => q.data)}
      />
    </Card>
  );
}

interface AccessAgentRow {
  agent: Agent;
  access: AgentAccess | undefined;
}

/**
 * Agents × tools in a large dialog. Clicking a cell cycles (sem acesso →
 * liberada → bloqueada → sem acesso); nothing saves until "Salvar", which
 * sends one PUT per changed agent. "Descartar" goes back.
 */
export function AccessMatrixDialog({
  open,
  onClose,
  agents,
  access,
}: {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  access: (AgentAccess | undefined)[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const areaLabel = useAreaLabel();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [staged, setStaged] = useState<Record<string, AccessModel>>({});
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const trees = useMemo(() => access.map((x) => (x ? treeFromAccess(x, areaLabel) : null)), [access, areaLabel]);
  const base = useMemo(() => access.map((x) => (x ? modelFrom(x) : null)), [access]);
  useEffect(() => {
    if (!open) {
      setStaged({});
      setConfirm(false);
      setQuery("");
    }
  }, [open]);
  const modelOf = (i: number) => {
    const agent = agents[i];
    return (agent && staged[agent.id]) || base[i] || null;
  };
  const changes = agents.reduce((n, a, i) => {
    const tree = trees[i];
    const b = base[i];
    const s = staged[a.id];
    return tree && b && s ? n + changedCells(tree, b, s) : n;
  }, 0);
  const rows = trees.find((x) => x) ?? [];
  const q = fold(query.trim());

  const save = async () => {
    setSaving(true);
    try {
      for (const [i, a] of agents.entries()) {
        const s = staged[a.id];
        const tree = trees[i];
        const b = base[i];
        if (!s || !tree || !b || changedCells(tree, b, s) === 0) continue;
        const saved = await api.access.set(org.id, a.id, toInput(s, tree));
        qc.setQueryData(keys.agentAccess(org.id, a.id), saved);
      }
      void qc.invalidateQueries({ queryKey: keys.access(org.id) });
      toast.show(t("access.matrixSaved", { count: changes }));
      setStaged({});
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const tryClose = () => (changes > 0 ? setConfirm(true) : onClose());
  const stateLabel = (s: AccessState | "partial") => t(`access.state.${s}`);
  /** "Liberada por Escrever issues" / "Liberada por Todas as ferramentas". */
  const inheritedFrom = (model: AccessModel, group: ResolvedNode) =>
    model.grants.has(group.id) || group.locked || !model.allTools ? group.label : t("access.allTools");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && tryClose()}
      title={t("access.matrixDialog")}
      closeLabel={t("common.close")}
      width={1120}
      className="access-matrix-dialog"
    >
      <div className="ac-dialog__tools">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("access.matrixSearch")}
          aria-label={t("access.matrixSearch")}
        />
      </div>
      <div className="ac-dialog__list">
        {access.some((x) => !x) && agents.length > 0 && <LoadingList count={6} avatar={false} />}
        <div className="access-matrix" hidden={access.some((x) => !x) && agents.length > 0}>
          <table>
            <colgroup>
              <col className="access-matrix__first" />
              {agents.map((a) => (
                <col key={a.id} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="access-matrix__sticky">
                  {t("access.matrixTool")}
                </th>
                {agents.map((a) => (
                  <th key={a.id} scope="col">
                    {a.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const groupHit = !q || fold(`${g.label}`).includes(q);
                const hits = g.children.filter(
                  (x) =>
                    groupHit ||
                    fold(`${x.label} ${x.ref.kind === "tool" ? x.ref.name : ""} ${x.description ?? ""}`).includes(q),
                );
                if (!groupHit && hits.length === 0) return null;
                const isOpen = expanded.has(g.id) || (q !== "" && !groupHit);
                return (
                  <Fragment key={g.id}>
                    <tr className="access-matrix__group">
                      <th scope="row" className="access-matrix__sticky">
                        <button
                          type="button"
                          className="access-matrix__toggle"
                          aria-expanded={isOpen}
                          aria-label={t(isOpen ? "access.collapse" : "access.expand", { name: g.label })}
                          onClick={() =>
                            setExpanded((s) => {
                              const next = new Set(s);
                              if (next.has(g.id)) next.delete(g.id);
                              else next.add(g.id);
                              return next;
                            })
                          }
                        >
                          <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={16} />
                          <span>{t("access.groupCount", { name: g.label, count: g.children.length })}</span>
                          {g.custom && <span className="small muted">{t("access.customNote")}</span>}
                        </button>
                      </th>
                      {agents.map((a, i) => {
                        const model = modelOf(i);
                        const tree = trees[i];
                        const rg = model && tree ? resolve(tree, model).find((x) => x.id === g.id) : undefined;
                        const state = rg ? groupState(rg.children.map((x) => x.state)) : "off";
                        const label = t("access.cell", { agent: a.name, tool: g.label, state: stateLabel(state) });
                        return (
                          <td key={a.id} className="access-matrix__cell" data-state={state}>
                            <span className="access-matrix__icon" role="img" aria-label={label} title={label}>
                              <Icon name={STATE_ICON[state]} size={16} />
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                    {isOpen &&
                      hits.map((x) => (
                        <tr key={x.id} className="access-matrix__tool">
                          <th scope="row" className="access-matrix__sticky">
                            <span className="access-matrix__tool-name">{x.label}</span>
                          </th>
                          {agents.map((a, i) => {
                            const model = modelOf(i);
                            const tree = trees[i];
                            const rg = model && tree ? resolve(tree, model).find((y) => y.id === g.id) : undefined;
                            const cell = rg?.children.find((y) => y.id === x.id);
                            const state = cell?.state ?? "off";
                            const changed =
                              model && tree && base[i] && staged[a.id]
                                ? statesOf(resolve(tree, base[i] as AccessModel)).get(x.id) !== state
                                : false;
                            const why =
                              state === "inherited" && model && rg
                                ? t("access.inheritedFrom", { from: inheritedFrom(model, rg) })
                                : stateLabel(state);
                            const label = t("access.cell", { agent: a.name, tool: x.label, state: why });
                            return (
                              <td
                                key={a.id}
                                className="access-matrix__cell"
                                data-state={state}
                                data-changed={changed || undefined}
                              >
                                <button
                                  type="button"
                                  className="access-matrix__btn"
                                  aria-label={label}
                                  title={why}
                                  disabled={!model || !tree || saving}
                                  onClick={() => {
                                    if (!model || !tree) return;
                                    const key = x.id.replace(/^tool:/, "");
                                    setStaged((st) => ({ ...st, [a.id]: cycleTool(model, tree, key) }));
                                  }}
                                >
                                  <Icon name={STATE_ICON[state]} size={16} />
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {confirm ? (
        <DialogFooter bar note={t("edit.discardQuestion")}>
          <Button onClick={() => setConfirm(false)}>{t("edit.keepEditing")}</Button>
          <Button variant="danger" onClick={onClose}>
            {t("edit.discard")}
          </Button>
        </DialogFooter>
      ) : (
        <DialogFooter
          bar
          note={
            <span className="access-matrix__foot">
              <span className="access-matrix__legend small muted">
                {(["granted", "inherited", "denied", "off"] as const).map((s) => (
                  <span key={s} className="actor-label" data-state={s}>
                    <Icon name={STATE_ICON[s]} size={14} />
                    {stateLabel(s)}
                  </span>
                ))}
              </span>
              {changes > 0 && <span className="small">{t("access.changes", { count: changes })}</span>}
            </span>
          }
        >
          <Button disabled={changes === 0 || saving} onClick={() => setStaged({})}>
            {t("access.discardChanges")}
          </Button>
          <Button variant="primary" disabled={changes === 0 || saving} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      )}
    </Dialog>
  );
}
