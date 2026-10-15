import { WorkSummary } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRun } from "@/api/queries";
import { useOrg } from "@/components/org-context";
import { agentGrammar } from "@/lib/grammar";
import { formatDuration, stepLabel, workFromSteps, workHeader, workMeta } from "@/lib/work";

/**
 * "4 passos · himetrica, Drive · 12 s" under an agent's message. The header
 * comes from `meta.work` when the server sends it; the steps load from
 * `GET …/runs/{id}` only when opened (one request per opened message).
 */
export function MessageWork({
  runId,
  meta,
  agentName,
}: {
  runId: string;
  meta: Record<string, unknown> | undefined;
  agentName: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const run = useRun(org.id, open ? runId : null);
  const compact = workMeta(meta);
  const work = run.data ? workFromSteps(run.data.steps, run.data.run) : null;
  // Nothing to say: the server says it used no tools.
  if (compact && compact.steps === 0) return null;
  const header = work
    ? workHeader(t, { steps: work.steps.length, connectors: work.connectors, durationMs: work.durationMs })
    : compact
      ? workHeader(t, compact)
      : null;
  const summary = header ? (
    <>
      <strong>{header.steps}</strong>
      {header.connectors && ` · ${header.connectors}`}
      {header.duration && ` · ${header.duration}`}
    </>
  ) : (
    <strong>{t("chat.work.see", agentGrammar(t, agentName))}</strong>
  );
  const steps = run.isError
    ? [{ key: "error", label: t("chat.work.failed"), failed: true }]
    : !work
      ? open
        ? [{ key: "loading", label: t("common.loading"), pending: true }]
        : []
      : work.steps.length === 0
        ? [{ key: "none", label: t("chat.work.none") }]
        : work.steps.map((s) => ({
            key: s.key,
            label: stepLabel(t, s),
            time: s.ms !== null ? formatDuration(t, s.ms) : undefined,
            failed: s.failed,
          }));
  return <WorkSummary summary={summary} steps={steps} onToggle={setOpen} />;
}
