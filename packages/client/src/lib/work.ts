import type { TFunction } from "i18next";
import type { Run, RunStep } from "../api/types";
import type { LiveCode, LiveOutput, LiveWork } from "../realtime/streams";
import { type ActivityKind, toolActivity } from "./activity";
import { joinNames } from "./format";

/** Fallback when a tool has no label: "github_merge_pull_request" → "github merge pull request". */
export const toolLabel = (name: string) => name.replace(/[_-]+/g, " ").trim();

/** One thing the agent did (a tool call), for the work summary. */
export interface WorkItem {
  key: string;
  kind: ActivityKind;
  app?: string;
  tool: string;
  ms: number | null;
  failed: boolean;
  /** How many calls in a row this line stands for (five "Usou o navegador" are one line). */
  count: number;
  /** The code it ran (`run_code`, skill scripts: `input.code`/`input.command`) and what came out. */
  code?: LiveCode;
  output?: LiveOutput[];
}

/** What the agent said before a model call's tools (`model_call` step: `narration`, `turn`). */
export interface WorkNarration {
  key: string;
  turn: number;
  text: string;
  /** How many tool calls came before it (where it goes among the steps). */
  at: number;
}

export interface Work {
  steps: WorkItem[];
  /** The narration between tool calls, in order. */
  narration: WorkNarration[];
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
  const narration: WorkNarration[] = [];
  const connectors: string[] = [];
  for (const s of steps) {
    if (s.kind === "model_call") {
      const text = typeof s.data.narration === "string" ? s.data.narration.trim() : "";
      if (text)
        narration.push({
          key: `say-${s.seq}`,
          turn: typeof s.data.turn === "number" ? s.data.turn : narration.length,
          text,
          at: items.length,
        });
      continue;
    }
    if (s.kind !== "tool_call") continue;
    const name = typeof s.data.name === "string" ? s.data.name : "";
    const id = typeof s.data.toolUseId === "string" ? s.data.toolUseId : `${s.seq}`;
    const result = results.get(id);
    const a = toolActivity(name);
    const app = a.kind === "consulting" ? a.app : DRIVE.includes(a.kind) ? "Drive" : undefined;
    if (app && !connectors.includes(app)) connectors.push(app);
    const input = (s.data.input ?? {}) as Record<string, unknown>;
    const source =
      typeof input.code === "string" ? input.code : typeof input.command === "string" ? input.command : null;
    const content = typeof result?.data.content === "string" ? result.data.content : "";
    const failed = result?.data.isError === true;
    const ms = result ? Math.max(0, time(result.createdAt) - time(s.createdAt)) : null;
    // The same thing again, with nothing said in between and no code to show: one line, not five.
    const prev = items[items.length - 1];
    if (
      prev &&
      source === null &&
      !prev.code &&
      sameActivity(prev, { kind: a.kind, app: a.app, tool: name }) &&
      narration[narration.length - 1]?.at !== items.length
    ) {
      prev.count += 1;
      prev.ms = prev.ms !== null && ms !== null ? prev.ms + ms : (prev.ms ?? ms);
      prev.failed ||= failed;
      continue;
    }
    items.push({
      key: id,
      kind: a.kind,
      app: a.app,
      tool: name,
      ms,
      failed,
      count: 1,
      ...(source !== null
        ? {
            code: {
              language:
                typeof input.language === "string"
                  ? input.language
                  : typeof input.command === "string"
                    ? "bash"
                    : "python",
              source,
            },
            output: content ? [{ stream: failed ? ("stderr" as const) : ("stdout" as const), text: content }] : [],
          }
        : {}),
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
  return { steps: items, narration, connectors, durationMs };
}

/** Calls that read as the same line ("Usou o navegador"); an unknown tool's line names the tool. */
export const sameActivity = (
  a: { kind: ActivityKind; app?: string; tool: string },
  b: { kind: ActivityKind; app?: string; tool: string },
) => a.kind === b.kind && (a.app ?? "") === (b.app ?? "") && (a.kind !== "usingTool" || a.tool === b.tool);

/** How many tool calls the work stands for (folded lines count each call). */
export const workCalls = (w: Work) => w.steps.reduce((n, s) => n + s.count, 0);

/**
 * The live work with repeats folded: a call followed by the same kind of call (no code or output to
 * show) is dropped, so five browser steps and the one running read as "Usando o navegador…".
 */
export function foldLiveWork(work: LiveWork[]): LiveWork[] {
  const plain = (w: LiveWork | undefined) =>
    w?.kind === "call" && !w.code && w.output.length === 0
      ? { ...toolActivity(w.tool, w.connector, w.detail), tool: w.tool }
      : null;
  return work.filter((w, i) => {
    const a = plain(w);
    const b = plain(work[i + 1]);
    return !(a && b && sameActivity(a, b));
  });
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

/** "Consultou o himetrica", "Atualizou o plano", and for an unknown tool "Usou a ferramenta send email". */
export function stepLabel(t: TFunction, s: WorkItem) {
  return t(`chat.work.step.${s.kind}`, { app: s.app ?? "", tool: toolLabel(s.tool) });
}

/**
 * A message of a stopped run (`meta.canceled`, `true` or `{ byUserId }`) ends
 * with the server's "_Interrompido por Walter._": that line leaves the text,
 * and the note is written on the client, in the UI language, from the meta.
 * `note` is the server's line (only a fallback when the meta has no person).
 */
export function splitCanceled(body: string, meta: Record<string, unknown> | undefined) {
  const canceled = meta?.canceled;
  if (!canceled) return { body, canceled: false, byUserId: null as string | null, note: null as string | null };
  const byUserId =
    typeof canceled === "object" && canceled && typeof (canceled as { byUserId?: unknown }).byUserId === "string"
      ? ((canceled as { byUserId: string }).byUserId as string)
      : null;
  // The server also sends what the agent wrote, without the note.
  const said = typeof canceled === "object" && canceled ? (canceled as { text?: unknown }).text : undefined;
  const match = /\n*\s*_([^_\n]+)_\s*$/.exec(body);
  if (typeof said === "string")
    return { body: said, canceled: true, byUserId, note: match?.[1]?.trim().replace(/\.$/, "") ?? null };
  if (!match) return { body, canceled: true, byUserId, note: null };
  return {
    body: body.slice(0, match.index).trimEnd(),
    canceled: true,
    byUserId,
    note: (match[1] ?? "").trim().replace(/\.$/, ""),
  };
}
