import {
  type ContentBlock,
  contextWindowOf,
  type ModelMessage,
  type SystemBlock,
  type ToolSpec,
  textOf,
} from "@agenteschat/providers";
import type { Judge } from "./judge";

/**
 * Context budget of a run: before each model call the request's size is
 * estimated locally (no network, any provider), and when it wouldn't fit the
 * model's window, old tool results give way to a short placeholder until it
 * does. The latest turn's results, the system prompt and every text the
 * people and the agent wrote stay as they are. The judge (Jev) picks which
 * results go ("does the agent still need this to finish?"), lowest
 * probability first; without an answer in time, the oldest go first. Nothing
 * is summarized: a removed result is one tool call away.
 *
 * The engine saves the compacted messages on the transcript: later turns and
 * resumes send the same history (the prompt cache breaks once, at the
 * compaction, not every turn), and the judge only runs again when the run
 * grows past the budget again. When even removing every old result isn't
 * enough, the call goes as it is (no new failure mode).
 */

/**
 * Characters per token of the estimate. Real tokenizers give ~3.5–4 for prose
 * and ~2.5–3 for code and JSON (what tool results mostly are); 3 errs on the
 * side of compacting a bit early rather than overflowing.
 */
export const CHARS_PER_TOKEN = 3;
/** Per message and per block: role markers, ids, JSON structure. */
const OVERHEAD_CHARS = 16;
/** Kept free besides the output tokens, for the estimate's error and what the provider adds (tool-use prompt). */
export const CONTEXT_MARGIN = 0.05;
/** The judge answers within this, or the oldest results go first. */
export const CONTEXT_BUDGET_TIMEOUT_MS = 1500;
/** Results shorter than this are left alone (a placeholder would save next to nothing). */
export const MIN_REMOVABLE_CHARS = 1000;
/** At most this many results go to the judge (the largest); the rest go last, oldest first. */
const MAX_JUDGED = 40;
/** Start of each result the judge reads. */
const EXCERPT_CHARS = 600;

const REMOVED_PREFIX = "[Result removed to save space:";
/** What a removed tool result says instead. */
export const removedPlaceholder = (chars: number) =>
  `${REMOVED_PREFIX} ${chars} chars. Call the tool again if you need it.]`;

const blockChars = (b: ContentBlock) =>
  b.type === "text"
    ? b.text.length
    : b.type === "tool_use"
      ? b.name.length + JSON.stringify(b.input).length
      : b.type === "tool_result"
        ? b.content.length
        : JSON.stringify(b.data).length;

/** Input tokens of a request, estimated: characters of the system blocks, messages and tool schemas over `CHARS_PER_TOKEN`. */
export function estimateRequestTokens(request: {
  system: SystemBlock[];
  messages: ModelMessage[];
  tools?: Pick<ToolSpec, "name" | "description" | "inputSchema">[];
}): number {
  let chars = 0;
  for (const s of request.system) chars += s.text.length;
  for (const m of request.messages) {
    chars += OVERHEAD_CHARS;
    if (typeof m.content === "string") chars += m.content.length;
    else for (const b of m.content) chars += OVERHEAD_CHARS + blockChars(b);
  }
  for (const t of request.tools ?? [])
    chars += OVERHEAD_CHARS + t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Past this, old results go even when the window has room: every turn resends the whole context (cost). */
export const MAX_CONTEXT_TOKENS = 500_000;

/** Input tokens a request may have: the window minus the output tokens and the margin, at most `MAX_CONTEXT_TOKENS`. */
export const contextBudgetTokens = (windowTokens: number, maxOutputTokens: number) =>
  Math.min(MAX_CONTEXT_TOKENS, Math.max(0, windowTokens - maxOutputTokens - Math.ceil(windowTokens * CONTEXT_MARGIN)));

/** A tool result that may be removed. `position`: its order in the run (0 = oldest). */
export interface ToolResultCandidate {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  chars: number;
  excerpt: string;
  position: number;
}

const hasToolResult = (m: ModelMessage) =>
  typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result");

/** Index of the last message that matches, or -1 (`findLastIndex` is past the ES2022 lib). */
const lastIndexOf = (messages: ModelMessage[], match: (m: ModelMessage) => boolean) => {
  for (let i = messages.length - 1; i >= 0; i--) if (match(messages[i] as ModelMessage)) return i;
  return -1;
};

/**
 * The tool results that may give way, oldest first: every one before the
 * latest message with results (the latest turn's), not removed already, and
 * long enough to be worth it.
 */
export function removableToolResults(messages: ModelMessage[]): ToolResultCandidate[] {
  const latest = lastIndexOf(messages, hasToolResult);
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const out: ToolResultCandidate[] = [];
  messages.forEach((m, i) => {
    if (typeof m.content === "string") return;
    for (const b of m.content) {
      if (b.type === "tool_use") calls.set(b.id, { name: b.name, input: b.input });
      else if (
        b.type === "tool_result" &&
        i < latest &&
        b.content.length >= MIN_REMOVABLE_CHARS &&
        !b.content.startsWith(REMOVED_PREFIX)
      ) {
        const call = calls.get(b.toolUseId);
        out.push({
          toolUseId: b.toolUseId,
          name: call?.name ?? "unknown",
          input: call?.input ?? {},
          chars: b.content.length,
          excerpt: b.content.slice(0, EXCERPT_CHARS),
          position: out.length,
        });
      }
    }
  });
  return out;
}

const savedChars = (c: ToolResultCandidate) => c.chars - removedPlaceholder(c.chars).length;

/**
 * Which results to remove to save `needChars`: lowest probability first
 * (`scores`, by tool use id; one without a score goes after the scored ones),
 * the oldest first among equals, or simply oldest first without scores.
 */
export function pickRemovals(
  candidates: ToolResultCandidate[],
  needChars: number,
  scores?: Record<string, number> | null,
): string[] {
  const score = (c: ToolResultCandidate) => (scores ? (scores[c.toolUseId] ?? 1) : 0);
  const order = [...candidates].sort((a, b) => score(a) - score(b) || a.position - b.position);
  const picked: string[] = [];
  let saved = 0;
  for (const c of order) {
    if (saved >= needChars) break;
    picked.push(c.toolUseId);
    saved += savedChars(c);
  }
  return picked;
}

/** The messages with those tool results replaced by the placeholder (untouched messages are the same objects). */
export function compactToolResults(messages: ModelMessage[], toolUseIds: Set<string>): ModelMessage[] {
  return messages.map((m) => {
    if (
      typeof m.content === "string" ||
      !m.content.some((b) => b.type === "tool_result" && toolUseIds.has(b.toolUseId))
    )
      return m;
    return {
      ...m,
      content: m.content.map((b) =>
        b.type === "tool_result" && toolUseIds.has(b.toolUseId)
          ? { ...b, content: removedPlaceholder(b.content.length) }
          : b,
      ),
    };
  });
}

/** What the person asked: `task`, else the latest message of a person (not a tool result). */
function taskOf(messages: ModelMessage[], task: string | undefined): string {
  if (task?.trim()) return task;
  const i = lastIndexOf(messages, (m) => m.role === "user" && !hasToolResult(m) && textOf(m.content).trim() !== "");
  return i >= 0 ? textOf((messages[i] as ModelMessage).content) : "";
}

/**
 * One calibrated yes/no per result (the largest `MAX_JUDGED`), all in one
 * judge request: "does the agent still need this to finish?". Null scores
 * when the judge doesn't answer in time or fails.
 */
async function scoreToolResults(
  judge: Judge,
  input: {
    orgId: string;
    agentId?: string;
    runId?: string;
    task: string;
    now: string;
    candidates: ToolResultCandidate[];
    timeoutMs?: number;
  },
): Promise<{ scores: Record<string, number> | null; source: "judge" | "timeout" | "error" }> {
  const judged = [...input.candidates].sort((a, b) => b.chars - a.chars).slice(0, MAX_JUDGED);
  const questions = Object.fromEntries(
    judged.map((c, i) => [
      `r${i}`,
      {
        type: "noul" as const,
        instructions: `An AI agent is working on \`task\` for a person; \`now\` is what it said last. Earlier in this run it called a tool and got the result below. Does it still need this result in front of it to finish the task? Tool: ${c.name} ${JSON.stringify(c.input).slice(0, 300)}. Result (${c.chars} chars, start): ${c.excerpt}`,
        criteria: {
          true: "It still needs it: what it is doing now builds on this result, or its answer depends on details only this result has.",
          false: "It no longer needs it: the step it served is done, or it was not useful.",
        },
      },
    ]),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), input.timeoutMs ?? CONTEXT_BUDGET_TIMEOUT_MS);
  });
  try {
    const answers = await Promise.race([
      judge.ask({
        orgId: input.orgId,
        agentId: input.agentId,
        runId: input.runId,
        kind: "context_budget",
        calibrated: true,
        state: { task: input.task.slice(0, 2000), now: input.now.slice(0, 1500) },
        questions,
      }),
      timeout,
    ]);
    if (answers === "timeout") return { scores: null, source: "timeout" };
    const scores: Record<string, number> = {};
    judged.forEach((c, i) => {
      // Unanswered: kept, like an unscored result in `pickRemovals` (never removed ahead of one judged unneeded).
      scores[c.toolUseId] = Math.round((answers[`r${i}`]?.noul ?? 1) * 1000) / 1000;
    });
    return { scores, source: "judge" };
  } catch {
    return { scores: null, source: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** What a compaction did, for the run's `context` step. */
export interface ContextBudgetReport {
  windowTokens: number;
  budgetTokens: number;
  /** Estimated input tokens before and after. */
  estimatedTokens: number;
  afterTokens: number;
  removed: number;
  removedChars: number;
  /** Who picked: the judge, why it fell back to oldest first ("timeout", "error", "none"), or "all" (every old result had to go). */
  source: "judge" | "timeout" | "error" | "none" | "all";
  /** The removed results' probabilities (judge only). */
  scores?: Record<string, number>;
  /** Still over budget after removing every old result: the call goes as it is. */
  fits: boolean;
}

/**
 * Fits the request of the next model call into the model's window: null when
 * it fits (or nothing can be removed), else the compacted messages and what
 * was done. The judge is asked only here, when over budget.
 */
export async function fitContextWindow(
  judge: Judge | null | undefined,
  input: {
    orgId: string;
    /** The agent and run, for the judge's usage record. */
    agentId?: string;
    runId?: string;
    model: string;
    /** Overrides the catalog's window (tests). */
    windowTokens?: number;
    maxOutputTokens: number;
    system: SystemBlock[];
    messages: ModelMessage[];
    tools?: Pick<ToolSpec, "name" | "description" | "inputSchema">[];
    /** What the run answers (the trigger); the latest person message when empty. */
    task?: string;
    timeoutMs?: number;
  },
): Promise<{ messages: ModelMessage[]; report: ContextBudgetReport } | null> {
  const windowTokens = input.windowTokens ?? contextWindowOf(input.model);
  const budgetTokens = contextBudgetTokens(windowTokens, input.maxOutputTokens);
  const estimatedTokens = estimateRequestTokens(input);
  if (estimatedTokens <= budgetTokens) return null;
  const candidates = removableToolResults(input.messages);
  if (candidates.length === 0) return null;
  const needChars = (estimatedTokens - budgetTokens) * CHARS_PER_TOKEN;
  let scores: Record<string, number> | null = null;
  let source: ContextBudgetReport["source"];
  if (candidates.reduce((n, c) => n + savedChars(c), 0) <= needChars) source = "all";
  else if (!judge) source = "none";
  else {
    const last = input.messages[lastIndexOf(input.messages, (m) => m.role === "assistant")];
    const judged = await scoreToolResults(judge, {
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      task: taskOf(input.messages, input.task),
      now: last ? textOf(last.content) : "",
      candidates,
      timeoutMs: input.timeoutMs,
    });
    scores = judged.scores;
    source = judged.source;
  }
  const ids = pickRemovals(candidates, needChars, scores);
  const finalScores = scores;
  const removed = new Set(ids);
  const messages = compactToolResults(input.messages, removed);
  const afterTokens = estimateRequestTokens({ ...input, messages });
  return {
    messages,
    report: {
      windowTokens,
      budgetTokens,
      estimatedTokens,
      afterTokens,
      removed: ids.length,
      removedChars: candidates.filter((c) => removed.has(c.toolUseId)).reduce((n, c) => n + c.chars, 0),
      source,
      ...(finalScores ? { scores: Object.fromEntries(ids.map((id) => [id, finalScores[id] ?? 1])) } : {}),
      fits: afterTokens <= budgetTokens,
    },
  };
}
