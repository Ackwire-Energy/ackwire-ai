import { Card, Icon, type IconName, SearchInput } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useAccessMatrix, useCatalog } from "@/api/queries";
import type { AccessMatrix, AccessState } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { cycleTool, isOn, modelFrom, toInput, toolLabel, treeFromAccess } from "@/lib/access";
import { can } from "@/lib/permissions";

export const STATE_ICON: Record<AccessState | "partial", IconName> = {
  granted: "check",
  inherited: "checks",
  denied: "block",
  off: "dash",
  partial: "dash",
};

type Tool = AccessMatrix["tools"][number];

/** Rows of the matrix: built-in tools by scope, connector tools by connection. */
export function matrixGroups(matrix: AccessMatrix, scopeLabel: (scope: string) => string) {
  const groups = new Map<string, { id: string; label: string; tools: Tool[] }>();
  for (const tool of matrix.tools) {
    const id = tool.connectionId === null ? `scope:|${tool.scope}` : `connector:${tool.connectionId}`;
    const label = tool.connectionId === null ? scopeLabel(tool.scope) : tool.group;
    const g = groups.get(id) ?? { id, label, tools: [] };
    g.tools.push(tool);
    groups.set(id, g);
  }
  return [...groups.values()];
}

/** A group's cell: every tool on, none, or some. */
export function groupState(states: AccessState[]): AccessState | "partial" {
  const on = states.filter(isOn);
  if (on.length === states.length) return states.includes("granted") ? "granted" : "inherited";
  if (on.length === 0) return states.includes("denied") ? "denied" : "off";
  return "partial";
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Settings → "Acesso dos agentes" (admins): agents as columns, tool groups as rows (expandable into tools). */
export function AccessMatrixSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const admin = can(org.role, "configure");
  const matrix = useAccessMatrix(org.id, admin);
  const catalog = useCatalog();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // A tool cell: read the agent's access, change that tool, save it back.
  const change = useMutation({
    mutationFn: async ({ agentId, key }: { agentId: string; key: string }) => {
      const access = await api.access.get(org.id, agentId);
      const tree = treeFromAccess(access);
      return api.access.set(org.id, agentId, toInput(cycleTool(modelFrom(access), tree, key), tree));
    },
    onSuccess: (saved, { agentId }) => {
      qc.setQueryData(keys.agentAccess(org.id, agentId), saved);
      void qc.invalidateQueries({ queryKey: keys.accessMatrix(org.id) });
    },
  });
  const m = matrix.data;
  const groups = useMemo(() => {
    if (!m) return [];
    const scopes = catalog.data?.builtinScopes ?? [];
    return matrixGroups(
      m,
      (scope) => scopes.find((s) => s.id === scope)?.label ?? (scope === "" ? t("access.askGroup") : scope),
    );
  }, [m, catalog.data, t]);
  if (!admin) return null;
  const q = fold(query.trim());
  const stateLabel = (s: AccessState | "partial") => t(`access.state.${s}`);

  return (
    <Card aria-labelledby="sec-access">
      <div className="stack-4" style={{ gap: 2 }}>
        <h2 id="sec-access" className="ac-card__title">
          {t("access.matrixTitle")}
        </h2>
        <span className="small muted">{t("access.matrixSubtitle")}</span>
      </div>
      {matrix.isError && <p className="small muted">{t("access.unavailable")}</p>}
      {m && (
        <>
          <div className="row" style={{ gap: 12, alignItems: "center" }}>
            <SearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("access.matrixSearch")}
              aria-label={t("access.matrixSearch")}
            />
            <span className="access-matrix__legend small muted">
              {(["granted", "inherited", "denied", "off"] as const).map((s) => (
                <span key={s} className="actor-label">
                  <Icon name={STATE_ICON[s]} size={14} />
                  {stateLabel(s)}
                </span>
              ))}
            </span>
          </div>
          <div className="access-matrix">
            <table>
              <thead>
                <tr>
                  <th scope="col" className="access-matrix__sticky">
                    {t("access.matrixTool")}
                  </th>
                  {m.agents.map((a) => (
                    <th key={a.id} scope="col">
                      {a.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const groupHit = !q || fold(g.label).includes(q);
                  const hits = g.tools.filter(
                    (x) => groupHit || fold(`${x.label || toolLabel(x.name)} ${x.name} ${x.description}`).includes(q),
                  );
                  if (!groupHit && hits.length === 0) return null;
                  const expanded = open.has(g.id) || (q !== "" && !groupHit);
                  return (
                    <Fragment key={g.id}>
                      <tr className="access-matrix__group">
                        <th scope="row" className="access-matrix__sticky">
                          <button
                            type="button"
                            className="access-matrix__toggle"
                            aria-expanded={expanded}
                            aria-label={t(expanded ? "access.collapse" : "access.expand", { name: g.label })}
                            onClick={() =>
                              setOpen((s) => {
                                const next = new Set(s);
                                if (next.has(g.id)) next.delete(g.id);
                                else next.add(g.id);
                                return next;
                              })
                            }
                          >
                            <Icon name={expanded ? "chevronDown" : "chevronRight"} size={16} />
                            {g.label}
                          </button>
                        </th>
                        {m.agents.map((a) => {
                          const state = groupState(g.tools.map((x) => m.cells[a.id]?.[x.key] ?? "off"));
                          const label = t("access.cell", { agent: a.name, tool: g.label, state: stateLabel(state) });
                          return (
                            <td key={a.id} className="access-matrix__cell" data-state={state}>
                              <span className="access-matrix__btn" role="img" aria-label={label} title={label}>
                                <Icon name={STATE_ICON[state]} size={16} />
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                      {expanded &&
                        hits.map((x) => (
                          <tr key={x.key} className="access-matrix__tool">
                            <th scope="row" className="access-matrix__sticky">
                              <span className="access-matrix__tool-name">{x.label || toolLabel(x.name)}</span>
                            </th>
                            {m.agents.map((a) => {
                              const state = m.cells[a.id]?.[x.key] ?? "off";
                              const label = t("access.cell", {
                                agent: a.name,
                                tool: x.label || toolLabel(x.name),
                                state: stateLabel(state),
                              });
                              return (
                                <td key={a.id} className="access-matrix__cell" data-state={state}>
                                  <button
                                    type="button"
                                    className="access-matrix__btn"
                                    aria-label={label}
                                    title={label}
                                    disabled={change.isPending}
                                    onClick={() => change.mutate({ agentId: a.id, key: x.key })}
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
        </>
      )}
    </Card>
  );
}
