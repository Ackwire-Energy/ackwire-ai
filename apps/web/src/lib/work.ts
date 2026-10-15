import type { TFunction } from "i18next";
import type { Run, RunStep } from "@/api/types";
import { toolLabel } from "./access";
import { type ActivityKind, toolActivity } from "./activity";
import { joinNames } from "./format";

/** One thing the agent did (a tool call), for the work summary. */
export interface WorkItem {
  key: string;
  kind: ActivityKind;
  app?: string;
  tool: string;
  ms: number | null;
  failed: boolean;
}

export interface Work {
  steps: WorkItem[];
  /** Apps it used ("himetrica", "Drive"), in order of first use. */
  connectors: string[];
  durationMs: number | null;
}

/** The compact form the backend may put on the message (`meta.work`), before the steps are loaded. */
export interface WorkMeta {
  steps: number;
  connectors: string[];
  durationMs: number | null;
}

export function workMeta(meta: Record<string, unknown> | undefined): WorkMeta | null {
  const w = meta?.work as Partial<WorkMeta> | undefined;
  if (!w || typeof w.steps !== "number") return null;
  return {
    steps: w.steps,
    connectors: Array.isArray(w.connectors) ? w.connectors.filter((c): c is string => typeof c === "string") : [],
    durationMs: typeof w.durationMs === "number" ? w.durationMs : null,
  };
}

const DRIVE: ActivityKind[] = ["readingDrive", "writingDrive", "exportingFile", "importingFile"];
const time = (iso: string) => new Date(iso).getTime();

/** Tool calls of a run (paired with their results), the apps it used and how long it took. */
export function workFromSteps(steps: RunStep[], run?: Pick<Run, "createdAt" | "finishedAt">): Work {
  const results = new Map<string, RunStep>();
  for (const s of steps) {
    const id = s.data.toolUseId;
    if (s.kind === "tool_result" && typeof id === "string") results.set(id, s);
  }
  const items: WorkItem[] = [];
  const connectors: string[] = [];
  for (const s of steps) {
    if (s.kind !== "tool_call") continue;
    const name = typeof s.data.name === "string" ? s.data.name : "";
    const id = typeof s.data.toolUseId === "string" ? s.data.toolUseId : `${s.seq}`;
    const result = results.get(id);
    const a = toolActivity(name);
    const app = a.kind === "consulting" ? a.app : DRIVE.includes(a.kind) ? "Drive" : undefined;
    if (app && !connectors.includes(app)) connectors.push(app);
    items.push({
      key: id,
      kind: a.kind,
      app: a.app,
      tool: name,
      ms: result ? Math.max(0, time(result.createdAt) - time(s.createdAt)) : null,
      failed: result?.data.isError === true,
    });
  }
  const first = steps[0];
  const last = steps[steps.length - 1];
  const durationMs =
    run?.finishedAt && run.createdAt
      ? Math.max(0, time(run.finishedAt) - time(run.createdAt))
      : first && last
        ? Math.max(0, time(last.createdAt) - time(first.createdAt))
        : null;
  return { steps: items, connectors, durationMs };
}

/** "12 s", "3 min". */
export function formatDuration(t: TFunction, ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? t("chat.work.seconds", { n: s }) : t("chat.work.minutes", { n: Math.round(s / 60) });
}

/** The pieces of the header: "4 passos", "himetrica e Drive", "12 s". */
export function workHeader(t: TFunction, w: { steps: number; connectors: string[]; durationMs: number | null }) {
  return {
    steps: t("chat.work.steps", { count: w.steps }),
    connectors: w.connectors.length > 0 ? joinNames(w.connectors, ", ") : null,
    duration: w.durationMs !== null ? formatDuration(t, w.durationMs) : null,
  };
}

/** "Consultou o himetrica", "Criou uma issue", "Usou github list prs". */
export function stepLabel(t: TFunction, s: WorkItem) {
  return t(`chat.work.step.${s.kind}`, { app: s.app ?? "", tool: toolLabel(s.tool) });
}
