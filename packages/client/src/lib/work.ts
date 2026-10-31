import type { TFunction } from "i18next";
import type { ConnectorDef, Run, RunStep } from "../api/types";
import type { LiveCode, LiveOutput, LiveWork } from "../realtime/streams";
import { type Activity, type ActivityKind, activityVerb, appLabel, toolActivity } from "./activity";
import { POSTGRES_MARK } from "./databases";
import { joinNames } from "./format";
import { MAIL_BRANDS } from "./mail";

/** Fallback when a tool has no label: "github_merge_pull_request" → "github merge pull request". */
export const toolLabel = (name: string) => name.replace(/[_-]+/g, " ").trim();

/** One thing the agent did (a tool call), for the work summary: what it did, in which service. */
export interface WorkItem extends Activity {
  key: string;
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

/** A tool's first call in a reply's `meta.work`: its name, app and service (as the `tool_call` step says them). */
export interface WorkCall {
  name: string;
  connector?: string;
  service?: string;
  serviceIcon?: string;
}

/** The compact form the backend puts on the message (`meta.work`), before the steps are loaded. */
export interface WorkMeta {
  steps: number;
  /** Each tool's first call, in order (a dozen at most): the closed block's logos. */
  calls: WorkCall[];
  durationMs: number | null;
}

export function workMeta(meta: Record<string, unknown> | undefined): WorkMeta | null {
  const w = meta?.work as Partial<WorkMeta> | undefined;
  if (!w || typeof w.steps !== "number") return null;
  return {
    steps: w.steps,
    calls: Array.isArray(w.calls)
      ? w.calls.filter((c): c is WorkCall => typeof (c as Partial<WorkCall> | null)?.name === "string")
      : [],
    durationMs: typeof w.durationMs === "number" ? w.durationMs : null,
  };
}

/** A saved reply's apps before its steps load (`meta.work.calls`): the ones `toolApps` gives once they do. */
export const workApps = (calls: WorkCall[]) => uniqueApps(calls.map((c) => toolActivity(c.name, c.connector, null, c)));

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
    const a = toolActivity(name, typeof s.data.connector === "string" ? s.data.connector : null, null, {
      service: typeof s.data.service === "string" ? s.data.service : null,
      serviceIcon: typeof s.data.serviceIcon === "string" ? s.data.serviceIcon : null,
    });
    // A reaction already shows on the message it reacts to: never a step (the server's `meta.work` skips it too).
    if (a.kind === "reacting") continue;
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
      sameActivity(prev, { ...a, tool: name }) &&
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
      ...a,
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

/** Calls that read as the same line ("Usou o navegador") with the same logo; an unknown tool's line names the tool. */
export const sameActivity = (a: Activity & { tool: string }, b: Activity & { tool: string }) =>
  a.kind === b.kind &&
  (a.app ?? "") === (b.app ?? "") &&
  (a.service ?? "") === (b.service ?? "") &&
  (a.kind !== "usingTool" || a.tool === b.tool);

/** How many tool calls the work stands for (folded lines count each call). */
export const workCalls = (w: Work) => w.steps.reduce((n, s) => n + s.count, 0);

/**
 * The live work with repeats folded: a call followed by the same kind of call (no code or output to
 * show) is dropped, so five browser steps and the one running read as "Usando o navegador…".
 */
export function foldLiveWork(work: LiveWork[]): LiveWork[] {
  const plain = (w: LiveWork | undefined) =>
    w?.kind === "call" && !w.code && w.output.length === 0
      ? { ...toolActivity(w.tool, w.connector, w.detail, w), tool: w.tool }
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
 * issues", a server's whole label too: "acme_tools_find_orders" → "find orders"; a mailbox's or a database's
 * without the account it names: "mail_ana_search" → "search"). Never a connector's input: the live event doesn't
 * carry it either.
 */
export function toolHint(tool: string, activity: Activity, detail?: string | null) {
  if (detail?.trim()) return detail.trim();
  if (activity.kind !== "consulting") return null;
  const name = tool.trim().replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  if (activity.service === "mail" || activity.service === "postgres" || MAIL_BRANDS[activity.service ?? ""])
    return toolLabel(name.replace(/^(?:mail|pg)_[a-z0-9]+_/, "")) || null;
  const app = (activity.app ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const parts = name.split(/[_.:]/);
  let lead = 0;
  for (let joined = ""; app && lead < parts.length - 1 && joined !== app; lead++) {
    const next = joined + (parts[lead] ?? "").toLowerCase();
    if (!app.startsWith(next) && !(lead === 0 && next.startsWith(app))) break;
    joined = next;
  }
  return toolLabel(parts.slice(lead).join("_")) || null;
}

/** A line's state: working on it, done, it failed, or it didn't end (stopped during it, or it waits on a person). */
export type ToolState = "run" | "done" | "fail" | "stop";

/** One line of the tool block: a call (or several of the same in a row). */
export interface ToolLine extends Activity {
  key: string;
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

const sameLine = (a: ToolLine, b: Activity & { tool: string }) =>
  a.state !== "fail" && !a.code && !a.output && sameActivity(a, b);

/**
 * The live work as the block's items: a call followed by the same kind of call (no code, nothing said in
 * between, neither failed) is one line counting both, so five browser steps read "Usou o navegador ×5".
 * Reactions are left out, as in `workFromSteps`. `stopped`: the run was stopped, so the call still running shows
 * as stopped.
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
    const a = toolActivity(w.tool, w.connector, w.detail, w);
    if (a.kind === "reacting") return;
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
        ...a,
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
        ...(s.app ? { app: s.app } : {}),
        ...(s.service ? { service: s.service } : {}),
        ...(s.icon ? { icon: s.icon } : {}),
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

/** How many logos the block's line stacks: a few, so its words keep the room. */
const LOGOS_MAX = 4;

/** What makes an app one logo of the block: its service, else its name, else what one of our tools does. */
export const appKey = (a: Activity) =>
  a.service ? `service:${a.service}` : a.kind === "consulting" ? `app:${a.app ?? ""}` : `kind:${a.kind}`;

/** Each app once, in order of first use, the first few. */
function uniqueApps(activities: Activity[]) {
  const apps: Activity[] = [];
  for (const a of activities) {
    if (apps.length === LOGOS_MAX) break;
    if (apps.some((b) => appKey(b) === appKey(a))) continue;
    apps.push({
      kind: a.kind,
      ...(a.app ? { app: a.app } : {}),
      ...(a.service ? { service: a.service } : {}),
      ...(a.icon ? { icon: a.icon } : {}),
    });
  }
  return apps;
}

/** The apps it used, in order of first use (the block's logos, a few at most). */
export const toolApps = (items: ToolItem[]) => uniqueApps(linesOf(items));

/**
 * How a call's logo is drawn, as the connectors screens draw the service: our own icon for one of our tools
 * (`own`), our envelope for a mailbox whose maker has no mark here (`mail`), or the service's tile: its mark,
 * else a server's own icon, else a monogram of its name.
 */
export type CallLogo =
  | { kind: "own" }
  | { kind: "mail" }
  | {
      kind: "service";
      def: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
      image: string | null;
      label: string;
    };

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A call's logo: its service's mark (a mailbox's maker, Postgres, the catalog's by id or name), or ours. */
export function callLogo(
  a: Activity,
  catalog: Pick<ConnectorDef, "id" | "label" | "iconUrl" | "brandColor">[],
): CallLogo {
  if (a.service === "mail") return { kind: "mail" };
  const mark = a.service === "postgres" ? { iconUrl: POSTGRES_MARK, brandColor: null } : MAIL_BRANDS[a.service ?? ""];
  if (mark) return { kind: "service", def: mark, image: null, label: a.app ?? "" };
  const names = [a.service, a.kind === "consulting" ? a.app : undefined].flatMap((n) => (n ? [plain(n)] : []));
  const def = catalog.find((d) => names.includes(plain(d.id)) || names.includes(plain(d.label))) ?? null;
  if (!def && a.kind !== "consulting") return { kind: "own" };
  return { kind: "service", def, image: a.icon ?? null, label: a.app ?? def?.label ?? "" };
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
