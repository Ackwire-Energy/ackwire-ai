import { isScreenTool, type ScreenKind, useRun } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  formatDuration,
  stepLabel,
  workCalls,
  workFromSteps,
  workHeader,
  workMeta,
} from "@agenteschat/client/lib/work";
import { WorkSummary } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CodePanel } from "@/components/LiveCode";
import { useOrg } from "@/components/org-context";

/**
 * "4 passos · himetrica, Drive · 12 s" under an agent's message. The header
 * comes from `meta.work` when the server sends it; the steps load from
 * `GET …/runs/{id}` only when opened (one request per opened message).
 */
export function MessageWork({
  runId,
  meta,
  agentName,
  skipScreens = [],
}: {
  runId: string;
  meta: Record<string, unknown> | undefined;
  agentName: string;
  /** Screens whose calls have their own card on the message (`BrowserTrailCard`): left out here. */
  skipScreens?: ScreenKind[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const run = useRun(org.id, open ? runId : null);
  const compact = workMeta(meta);
  const onCard = (name: unknown) => skipScreens.some((screen) => isScreenTool(String(name ?? ""), screen));
  const work = run.data
    ? workFromSteps(
        run.data.steps.filter((s) => !(s.kind === "tool_call" && onCard(s.data.name))),
        run.data.run,
      )
    : null;
  // Nothing to say: the server says it used no tools.
  if (compact && compact.steps === 0) return null;
  const header = work
    ? workHeader(t, { steps: workCalls(work), connectors: work.connectors, durationMs: work.durationMs })
    : compact
      ? workHeader(t, compact)
      : null;
  // A quiet button: "Ver o que ela fez · 7 passos · 38 s" (the numbers when known).
  const summary = (
    <>
      <strong>{t("chat.work.see", agentGrammar(t, agentName))}</strong>
      {header && (
        <span className="ac-work__meta">
          {` · ${header.steps}`}
          {header.connectors && ` · ${header.connectors}`}
          {header.duration && ` · ${header.duration}`}
        </span>
      )}
    </>
  );
  const steps = run.isError
    ? [{ key: "error", label: t("chat.work.failed"), failed: true }]
    : !work
      ? open
        ? [{ key: "loading", label: t("common.loading"), pending: true }]
        : []
      : work.steps.length === 0
        ? [{ key: "none", label: t("chat.work.none") }]
        : work.steps.flatMap((s, i) => [
            // What it said before this call ("Go não está instalado; vou tentar com gcc.").
            ...work.narration.filter((n) => n.at === i).map((n) => ({ key: n.key, label: n.text, note: true })),
            {
              key: s.key,
              label: stepLabel(t, s),
              time: s.ms !== null ? formatDuration(t, s.ms) : undefined,
              failed: s.failed,
              // The code it ran, and its output, after the fact.
              detail: s.code ? <CodePanel code={s.code} output={s.output ?? []} /> : undefined,
            },
          ]);
  return <WorkSummary summary={summary} steps={steps} onToggle={setOpen} />;
}
