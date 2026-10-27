import type { TFunction } from "i18next";
import type { Run, RunStep } from "../api/types";
import type { LiveCode, LiveOutput, LiveWork } from "../realtime/streams";
import { type ActivityKind, activityVerb, appLabel, toolActivity } from "./activity";
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
  /** Grey words after its phrase (`toolHint`): the built-in's label or the connector tool's own name. */
  hint?: string | null;
  /** Why it failed: the first line of the tool's error. */
  why?: string | null;
  /** No result: it never ran (it waited on a person, or the run stopped first). */
  held?: boolean;
  /** What it was given and what it answered, for its open line (shortened). */
  input?: string | null;
  result?: string | null;
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
    const detail = typeof s.data.detail === "string" ? s.data.detail : null;
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
      if (failed) prev.why = firstLine(content);
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
      hint: toolHint(name, a, detail),
      why: failed ? firstLine(content) : null,
      ...(result ? {} : { held: true }),
      input: source === null ? shortJson(input) : null,
      result: source === null && content ? clip(content) : null,
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

/** "Consultou o Himetrica", "Atualizou o plano", and for an unknown tool "Usou a ferramenta send email". */
export function stepLabel(t: TFunction, s: WorkItem) {
  return t(`chat.work.step.${s.kind}`, { app: appLabel(s), tool: toolLabel(s.tool) });
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

// ───────────────────────────── the tool block (one per reply) ─────────────────────────────

/** How long a line's open view shows of what a tool was given and answered. */
const OPEN_MAX = 1200;

const clip = (text: string, max = OPEN_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const shortJson = (input: Record<string, unknown>) => {
  if (Object.keys(input).length === 0) return null;
  try {
    return clip(JSON.stringify(input, null, 2));
  } catch {
    return null;
  }
};

/** The first line of an error, short ("Connection to app_production timed out after 5s"). */
export const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line ? clip(line, 160) : null;
};

/**
 * The grey words after a line's phrase: a built-in tool's own short label (the skill, the issue, the file; the
 * engine's `toolDetail`), or a connector tool's own name without its app ("github_search_issues" → "search
 * issues"). Never a connector's input: the live event doesn't carry it either.
 */
export function toolHint(tool: string, activity: { kind: ActivityKind; app?: string }, detail?: string | null) {
  if (detail?.trim()) return detail.trim();
  if (activity.kind !== "consulting") return null;
  let name = tool.trim().replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  const app = (activity.app ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const [head, ...rest] = name.split(/[_.:]/);
  if (rest.length > 0 && head && app && (app.startsWith(head.toLowerCase()) || head.toLowerCase().startsWith(app)))
    name = rest.join("_");
  const words = toolLabel(name);
  return words || null;
}

/** A line's state: working on it, done, it failed, or it didn't end (stopped during it, or it waits on a person). */
export type ToolState = "run" | "done" | "fail" | "stop";

/** One line of the tool block: a call (or several of the same in a row). */
export interface ToolLine {
  key: string;
  kind: ActivityKind;
  app?: string;
  tool: string;
  state: ToolState;
  hint: string | null;
  ms: number | null;
  count: number;
  why: string | null;
  input: string | null;
  result: string | null;
  code?: LiveCode;
  output?: LiveOutput[];
}

/** What the block lists, in order: its calls, what the agent said between them, and the messages it read. */
export type ToolItem =
  | { kind: "call"; key: string; line: ToolLine }
  | { kind: "say"; key: string; text: string }
  | { kind: "steer"; key: string; messageId: string; now: boolean };

const sameLine = (a: ToolLine, b: { kind: ActivityKind; app?: string; tool: string }) =>
  a.state !== "fail" && !a.code && !a.output && sameActivity(a, b);

/**
 * The live work as the block's items: a call followed by the same kind of call (no code, nothing said in
 * between, neither failed) is one line counting both, so five browser steps read "Usou o navegador ×5".
 * `stopped`: the run was stopped, so the call still running shows as stopped.
 */
export function toolItemsLive(work: LiveWork[], stopped = false): ToolItem[] {
  const items: ToolItem[] = [];
  work.forEach((w, i) => {
    if (w.kind === "say") {
      items.push({ kind: "say", key: `say-${i}`, text: w.text });
      return;
    }
    if (w.kind === "steer") {
      items.push({ kind: "steer", key: `steer-${w.messageId}`, messageId: w.messageId, now: w.now === true });
      return;
    }
    const a = toolActivity(w.tool, w.connector, w.detail);
    // Held (it waits on a person, so it never ran) reads like a call stopped before it ended.
    const state: ToolState = w.running ? (stopped ? "stop" : "run") : w.failed ? "fail" : w.held ? "stop" : "done";
    const hasCode = Boolean(w.code) || w.output.length > 0;
    const prev = items[items.length - 1];
    if (prev?.kind === "call" && !hasCode && state !== "fail" && sameLine(prev.line, { ...a, tool: w.tool })) {
      prev.line.count += 1;
      prev.line.state = state;
      prev.line.ms = prev.line.ms !== null && w.ms !== undefined ? prev.line.ms + w.ms : (prev.line.ms ?? w.ms ?? null);
      return;
    }
    items.push({
      kind: "call",
      key: w.id,
      line: {
        key: w.id,
        kind: a.kind,
        app: a.app,
        tool: w.tool,
        state,
        hint: toolHint(w.tool, a, w.detail),
        ms: w.ms ?? null,
        count: 1,
        why: null,
        input: null,
        result: null,
        ...(w.code ? { code: w.code } : {}),
        ...(w.output.length > 0 ? { output: w.output } : {}),
      },
    });
  });
  return items;
}

/** A saved run's work (`workFromSteps`) as the block's items, the narration where it was said. */
export function toolItemsSaved(work: Work): ToolItem[] {
  return work.steps.flatMap((s, i): ToolItem[] => [
    ...work.narration.filter((n) => n.at === i).map((n) => ({ kind: "say" as const, key: n.key, text: n.text })),
    {
      kind: "call",
      key: s.key,
      line: {
        key: s.key,
        kind: s.kind,
        app: s.app,
        tool: s.tool,
        state: s.failed ? "fail" : s.held ? "stop" : "done",
        hint: s.hint ?? null,
        ms: s.ms,
        count: s.count,
        why: s.why ?? null,
        input: s.input ?? null,
        result: s.result ?? null,
        ...(s.code ? { code: s.code, output: s.output ?? [] } : {}),
      },
    },
  ]);
}

const linesOf = (items: ToolItem[]) => items.flatMap((i) => (i.kind === "call" ? [i.line] : []));

/** How many calls the items stand for (a folded line counts each). */
export const toolCalls = (items: ToolItem[]) => linesOf(items).reduce((n, l) => n + l.count, 0);

/** The apps it used, in order of first use (the block's logos). */
export function toolApps(items: ToolItem[]) {
  const apps: { kind: ActivityKind; app?: string }[] = [];
  for (const l of linesOf(items)) {
    const key = l.kind === "consulting" ? `app:${l.app ?? ""}` : `kind:${l.kind}`;
    if (!apps.some((a) => (a.kind === "consulting" ? `app:${a.app ?? ""}` : `kind:${a.kind}`) === key))
      apps.push({ kind: l.kind, ...(l.app ? { app: l.app } : {}) });
  }
  return apps;
}

/** The line the closed block shows while it works: the call running now, else the last one. */
export const toolNow = (items: ToolItem[]) => linesOf(items).at(-1) ?? null;

/**
 * A line's phrase: "Consultando o GitHub…" while it runs, "Consultou o GitHub" once done, "Deu erro
 * consultando o GitHub" when it failed, "Consultando o GitHub" (no dots) when the run stopped during it.
 */
export function toolPhrase(t: TFunction, l: Pick<ToolLine, "kind" | "app" | "tool" | "state">) {
  const verb = activityVerb(t, { kind: l.kind, app: l.app });
  if (l.state === "run") return `${capitalize(verb)}…`;
  if (l.state === "stop") return capitalize(verb);
  if (l.state === "fail") return t("chat.work.erred", { activity: verb });
  return t(`chat.work.step.${l.kind}`, { app: appLabel(l), tool: toolLabel(l.tool) });
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** "1,2 s", "760 ms": a line's time, finer than the block's. */
export function formatLineTime(locale: string, ms: number) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 60_000) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
