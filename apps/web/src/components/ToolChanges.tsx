import type { ToolChange } from "@agenteschat/client";
import { useAcceptToolChange, useToolChanges } from "@agenteschat/client";
import { inputFields } from "@agenteschat/client/lib/custom-tools";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";

/**
 * Settings → Conectores, for connector admins (ADR 0117): approved tools whose server changed what they say or take.
 * Agents keep the approved version until an admin accepts the new one here, side by side. Nothing when none waits.
 */
export function ToolChanges({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const changes = useToolChanges(orgId);
  const accept = useAcceptToolChange(orgId);
  const toast = useToast();
  const list = changes.data ?? [];
  if (list.length === 0) return null;
  return (
    <section className="tool-changes" aria-labelledby="tool-changes-title">
      <h3 id="tool-changes-title" className="tool-changes__title">
        {t("connectors.toolChanges.title")}
      </h3>
      <p className="small muted">{t("connectors.toolChanges.intro")}</p>
      {list.map((c) => (
        <article key={`${c.connectionId}:${c.toolName}`} className="tool-change">
          <div className="tool-change__head">
            <span className="tool-change__name">
              {c.connectionLabel} · <code>{c.toolName}</code>
            </span>
            <Button
              size="sm"
              loading={accept.isPending && accept.variables?.toolName === c.toolName}
              onClick={() =>
                accept.mutate(c, {
                  onSuccess: () => toast.show(t("connectors.toolChanges.accepted", { tool: c.toolName })),
                  onError: (e) => toast.show(errorText(t, e), "error"),
                })
              }
            >
              {t("connectors.toolChanges.accept")}
            </Button>
          </div>
          <div className="tool-change__sides">
            <Version label={t("connectors.toolChanges.before")} version={c.before} other={c.after} />
            <Version label={t("connectors.toolChanges.after")} version={c.after} other={c.before} />
          </div>
        </article>
      ))}
    </section>
  );
}

/** One side: its description and each input field as the model reads it, a field that differs on the other side marked. */
function Version({
  label,
  version,
  other,
}: {
  label: string;
  version: ToolChange["before"];
  other: ToolChange["before"];
}) {
  const { t } = useTranslation();
  const fields = inputFields(version.inputSchema);
  const otherJson = new Map(inputFields(other.inputSchema).map((f) => [f.name, f.json]));
  return (
    <div className="tool-change__side">
      <div className="small muted">{label}</div>
      <p className="tool-change__text">{version.description}</p>
      {fields.length > 0 ? (
        <>
          <div className="small muted">{t("connectors.toolChanges.input")}</div>
          <ul className="tool-change__fields">
            {fields.map((f) => {
              const changed = otherJson.get(f.name) !== f.json;
              return (
                <li
                  key={f.name}
                  className={changed ? "tool-change__field tool-change__field--changed" : "tool-change__field"}
                >
                  <code>{f.name}</code>
                  {f.type ? <span className="muted"> · {f.type}</span> : null}
                  {changed ? (
                    <span className="tool-change__tag">{t("connectors.toolChanges.fieldChanged")}</span>
                  ) : null}
                  {f.description ? <div className="tool-change__text">{f.description}</div> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className="small muted">{t("connectors.toolChanges.noInput")}</div>
      )}
    </div>
  );
}
