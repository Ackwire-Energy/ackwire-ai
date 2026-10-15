import { Button, Checkbox, Chip, SearchInput, Switch } from "@agenteschat/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AccessModel,
  type AccessNode,
  countTools,
  filterTree,
  isOn,
  type ResolvedNode,
  resolve,
  setAllTools,
  setDenied,
  toggle,
} from "@/lib/access";

const domId = (id: string) => `acc-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/** The tool tree of "Editar permissões" and "Criar agente → Ferramentas". */
export function AccessTree({
  tree,
  model,
  onChange,
}: {
  tree: AccessNode[];
  model: AccessModel;
  onChange: (next: AccessModel) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const resolved = useMemo(() => resolve(tree, model), [tree, model]);
  const shown = useMemo(() => filterTree(resolved, query), [resolved, query]);
  const count = countTools(resolved);
  // The raw node (with its children) to toggle, by id.
  const raw = useMemo(() => {
    const map = new Map<string, AccessNode>();
    const walk = (nodes: AccessNode[]) => {
      for (const n of nodes) {
        map.set(n.id, n);
        walk(n.children);
      }
    };
    walk(tree);
    return map;
  }, [tree]);
  const set = (n: ResolvedNode, on: boolean, covered: boolean) => {
    const node = raw.get(n.id);
    if (node) onChange(toggle(model, node, on, covered));
  };

  return (
    <div className="access-tree">
      <div className="access-tree__all">
        <Switch
          id="acc-all"
          checked={model.allTools}
          onCheckedChange={(on) => onChange(setAllTools(model, on))}
          aria-describedby={model.allTools ? "acc-all-note" : undefined}
        />
        <span className="list-col" style={{ gap: 2 }}>
          <label htmlFor="acc-all" style={{ fontWeight: 600 }}>
            {t("access.allTools")}
          </label>
          {model.allTools && (
            <span id="acc-all-note" className="small muted">
              {t("access.allToolsNote")}
            </span>
          )}
        </span>
      </div>
      <div className="row" style={{ gap: 12, alignItems: "center" }}>
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("access.search")}
          aria-label={t("access.search")}
        />
        <span className="small muted tabular" role="status">
          {t("access.count", { on: count.on, total: count.total })}
        </span>
      </div>
      {shown.length === 0 && <p className="small muted">{t("access.noResults")}</p>}
      {shown.map((group) => (
        <section key={group.id} className="access-group" aria-label={group.label}>
          <div className="access-group__head">
            {group.kind === "connector" ? (
              <>
                <span className="access-group__name">
                  {group.label}
                  {group.custom && <span className="small muted"> · {t("access.customNote")}</span>}
                </span>
                <span className="access-row__check">
                  <Checkbox
                    id={domId(group.id)}
                    checked={group.checked}
                    onCheckedChange={(on) => set(group, on, model.allTools)}
                  />
                  <label htmlFor={domId(group.id)} className="small">
                    {t("access.allOfConnector")}
                  </label>
                </span>
              </>
            ) : (
              <span className="access-row__check">
                <Checkbox
                  id={domId(group.id)}
                  checked={group.checked}
                  disabled={group.locked}
                  onCheckedChange={(on) => set(group, on, model.allTools)}
                />
                <label htmlFor={domId(group.id)} className="access-group__name">
                  {group.label}
                </label>
              </span>
            )}
          </div>
          <ul className="access-group__tools">
            {group.children.map((tool) => {
              const covered = group.state !== "denied" && isOn(group.state);
              const denied = tool.state === "denied";
              return (
                <li
                  key={tool.id}
                  className="access-row"
                  data-state={tool.state}
                  data-inherited={tool.state === "inherited" || undefined}
                >
                  <Checkbox
                    id={domId(tool.id)}
                    checked={tool.checked}
                    disabled={group.locked}
                    onCheckedChange={(on) => set(tool, on, covered)}
                    aria-describedby={tool.description ? `${domId(tool.id)}-desc` : undefined}
                  />
                  <span className="list-col access-row__text">
                    <label htmlFor={domId(tool.id)}>{tool.label}</label>
                    {tool.description && (
                      <span id={`${domId(tool.id)}-desc`} className="small muted">
                        {tool.description}
                      </span>
                    )}
                  </span>
                  {tool.sensitive && (
                    <Chip icon="waiting" tone="waiting">
                      {t("access.asksApproval")}
                    </Chip>
                  )}
                  {denied && <Chip icon="block">{t("access.blocked")}</Chip>}
                  {!group.locked && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={denied ? undefined : "block"}
                      aria-label={t(denied ? "access.unblockName" : "access.blockName", { name: tool.label })}
                      onClick={() => onChange(setDenied(model, tool.id, !denied))}
                    >
                      {t(denied ? "access.unblock" : "access.block")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
