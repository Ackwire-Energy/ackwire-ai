import type { ToolChange } from "@agenteschat/client";
import { useAcceptConnectionToolChanges, useAcceptToolChange, useToolChanges } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { type ToolChangeDiff, toolChangeDiff, toolChangeSummary } from "@agenteschat/client/lib/tool-changes";
import { Button, Diff } from "@agenteschat/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";

/** Tools shown per connection before "Mostrar todas": a server that changed many doesn't push the page down. */
const FIRST_TOOLS = 5;

/**
 * Settings → Conectores, for connector admins (ADR 0117): approved tools whose server changed what they say or take.
 * Agents keep the approved version until an admin accepts the new one. One block per connection ("Aceitar todas"),
 * one line per tool saying what changed, and only the changed sentences and fields behind "Ver a mudança".
 * Nothing when none waits.
 */
export function ToolChanges({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const changes = useToolChanges(orgId);
  const list = changes.data ?? [];
  const groups = useMemo(() => {
    const by = new Map<string, { connectionId: string; label: string; tools: ToolChange[] }>();
    for (const c of list) {
      const group = by.get(c.connectionId) ?? { connectionId: c.connectionId, label: c.connectionLabel, tools: [] };
      group.tools.push(c);
      by.set(c.connectionId, group);
    }
    return [...by.values()];
  }, [list]);
  if (list.length === 0) return null;
  return (
    <section className="tool-changes" aria-labelledby="tool-changes-title">
      <h3 id="tool-changes-title" className="tool-changes__title">
        {t("connectors.toolChanges.title")}
      </h3>
      <p className="small muted">{t("connectors.toolChanges.intro")}</p>
      {groups.map((g) => (
        <ConnectionChanges key={g.connectionId} orgId={orgId} {...g} />
      ))}
    </section>
  );
}

function ConnectionChanges({
  orgId,
  connectionId,
  label,
  tools,
}: {
  orgId: string;
  connectionId: string;
  label: string;
  tools: ToolChange[];
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const acceptAll = useAcceptConnectionToolChanges(orgId);
  const [all, setAll] = useState(false);
  const shown = all ? tools : tools.slice(0, FIRST_TOOLS);
  const titleId = `tool-changes-${connectionId}`;
  return (
    <article className="tool-changes__group" aria-labelledby={titleId}>
      <div className="tool-changes__head">
        <div className="tool-changes__who">
          <span id={titleId} className="tool-changes__name">
            {label}
          </span>
          <span className="small muted">{t("connectors.toolChanges.count", { count: tools.length })}</span>
        </div>
        {tools.length > 1 && (
          <Button
            size="sm"
            loading={acceptAll.isPending}
            onClick={() =>
              acceptAll.mutate(connectionId, {
                onSuccess: () => toast.show(t("connectors.toolChanges.acceptedAll", { name: label })),
                onError: (e) => toast.show(errorText(t, e), "error"),
              })
            }
          >
            {t("connectors.toolChanges.acceptAll")}
          </Button>
        )}
      </div>
      <ul className="tool-changes__tools">
        {shown.map((c) => (
          <ToolRow key={c.toolName} orgId={orgId} change={c} />
        ))}
      </ul>
      {tools.length > FIRST_TOOLS && !all && (
        <Button size="sm" variant="ghost" className="tool-changes__more" onClick={() => setAll(true)}>
          {t("connectors.toolChanges.showAll", { total: tools.length })}
        </Button>
      )}
    </article>
  );
}

/** One tool: its name, what changed in a few words, and the change itself on demand. */
function ToolRow({ orgId, change }: { orgId: string; change: ToolChange }) {
  const { t } = useTranslation();
  const toast = useToast();
  const accept = useAcceptToolChange(orgId);
  const [open, setOpen] = useState(false);
  const diff = useMemo(() => toolChangeDiff(change), [change]);
  const detailsId = `tool-change-${change.connectionId}-${change.toolName}`;
  return (
    <li className="tool-change">
      <div className="tool-change__row">
        <div className="tool-change__what">
          <code className="tool-change__name">{change.toolName}</code>
          <span className="small muted">{toolChangeSummary(t, diff)}</span>
        </div>
        <div className="tool-change__actions">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(!open)}
          >
            {t(open ? "connectors.toolChanges.hide" : "connectors.toolChanges.show")}
          </Button>
          <Button
            size="sm"
            loading={accept.isPending}
            aria-label={t("connectors.toolChanges.acceptOne", { tool: change.toolName })}
            onClick={() =>
              accept.mutate(change, {
                onSuccess: () => toast.show(t("connectors.toolChanges.accepted", { tool: change.toolName })),
                onError: (e) => toast.show(errorText(t, e), "error"),
              })
            }
          >
            {t("connectors.toolChanges.accept")}
          </Button>
        </div>
      </div>
      {open && (
        <div id={detailsId} className="tool-change__details">
          <ChangeDetails diff={diff} />
        </div>
      )}
    </li>
  );
}

function ChangeDetails({ diff }: { diff: ToolChangeDiff }) {
  const { t } = useTranslation();
  const labels = { addedLabel: t("connectors.toolChanges.added"), removedLabel: t("connectors.toolChanges.removed") };
  return (
    <>
      {diff.description && (
        <div className="tool-change__part">
          <div className="small muted">{t("connectors.toolChanges.description")}</div>
          <Diff aria-label={t("connectors.toolChanges.description")} lines={diff.description} {...labels} />
        </div>
      )}
      {diff.fields.map((f) => (
        <div key={f.name} className="tool-change__part">
          <div className="small muted">
            <code>{f.name}</code>
            {f.type ? ` · ${f.type}` : ""} · {t(`connectors.toolChanges.field.${f.status}`)}
          </div>
          {f.lines.length > 0 && <Diff aria-label={f.name} lines={f.lines} code={f.code} {...labels} />}
        </div>
      ))}
      {diff.schema && (
        <div className="tool-change__part">
          <div className="small muted">{t("connectors.toolChanges.input")}</div>
          <Diff aria-label={t("connectors.toolChanges.input")} lines={diff.schema} code {...labels} />
        </div>
      )}
    </>
  );
}
