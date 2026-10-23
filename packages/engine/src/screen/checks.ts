import { randomUUID } from "node:crypto";
import type { Judge, JudgeQuestion } from "../judge";
import {
  describeElement,
  type ScreenChanges,
  type ScreenElement,
  type ScreenImage,
  type ScreenObservation,
  screenText,
} from "./observation";

/**
 * Checks on a screen (ADR 0054), each one judge call instead of a turn of the
 * agent's own model: "is it true now?" (a step's `expect`, a wait `until`),
 * "where on this page is the answer?" (a read with `find`) and "what closes
 * what covers the page?" (a banner in the way of a click).
 */

interface Ids {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
}

/** A condition is taken as true from this probability, and as false below `FALSE_BELOW`. */
export const TRUE_AT = 0.6;
const FALSE_BELOW = 0.35;

export type ConditionResult = { met: true; p: number } | { met: false; p: number } | { met: null; p: number };

const changesText = (c: ScreenChanges | null | undefined) =>
  c && !c.newPage
    ? [...c.added.map((l) => `+ ${l.trim()}`), ...c.removed.map((l) => `- ${l.trim()}`)].join("\n").slice(0, 6000)
    : null;

/**
 * Whether the screen shows `condition` now ("the order is confirmed", "an
 * error says the card was declined"). With an image, the judge looks at it too
 * (what text alone can't say: a chart drew, a layout broke).
 */
export async function checkCondition(
  input: Ids & {
    condition: string;
    observation: ScreenObservation;
    changes?: ScreenChanges | null;
    image?: ScreenImage | null;
  },
): Promise<ConditionResult> {
  const placeholder = input.image ? `screen_${randomUUID()}` : null;
  const answers = await input.judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "screen_check",
    state: {
      condition: input.condition.trim(),
      screen: {
        address: input.observation.url,
        ...(changesText(input.changes) ? { what_just_changed: changesText(input.changes) } : {}),
        text: screenText(input.observation),
        ...(placeholder ? { screenshot: placeholder } : {}),
      },
    },
    ...(placeholder && input.image ? { images: { [placeholder]: { data: input.image.data, format: "jpeg" } } } : {}),
    questions: {
      holds: {
        type: "noul",
        instructions:
          "An agent just acted on `screen`. Does the screen show, right now, that `condition` is true? Judge only by what the screen shows.",
        criteria: {
          true: "The screen clearly shows it.",
          false: "The screen doesn't show it, shows the opposite, or is still loading.",
        },
      },
    },
  });
  const p = answers.holds?.noul ?? 0;
  if (p >= TRUE_AT) return { met: true, p };
  if (p < FALSE_BELOW) return { met: false, p };
  return { met: null, p };
}

/** Lines one Choice offers when finding an answer in a page (Jev takes 255 options). */
const WINDOW = 200;
/** Lines of context kept around each hit. */
const AROUND = 3;

export interface FoundInPage {
  /** `yes`: the page answers it; `partly`; `no`: nothing on it does. */
  answered: "yes" | "partly" | "no";
  /** The lines that answer it, with a little context, in page order. */
  text: string;
}

/**
 * Where on the page `question` is answered ("the order total", "is the
 * export done?"): the lines themselves, not the whole page. One request:
 * a Choice per window of lines and whether the page answers at all.
 */
export async function findInPage(
  input: Ids & { question: string; observation: ScreenObservation; maxChars?: number },
): Promise<FoundInPage> {
  const lines = input.observation.lines;
  if (lines.length === 0) return { answered: "no", text: "" };
  const id = (i: number) => `L${i + 1}`;
  const numbered = lines.map((l, i) => `${id(i)}: ${l.trim()}`).join("\n");
  const questions: Record<string, JudgeQuestion> = {
    answers: {
      type: "noul",
      instructions: "Does `page` answer `question` (states it, or shows it)?",
      criteria: {
        true: "At least one line of the page states or clearly shows the answer.",
        false: "No line of the page addresses it.",
      },
    },
  };
  const windows = Math.ceil(lines.length / WINDOW);
  for (let w = 0; w < windows; w++) {
    const criteria: Record<string, string> = {};
    for (let i = w * WINDOW; i < Math.min(lines.length, (w + 1) * WINDOW); i++) {
      criteria[id(i)] = (lines[i] as string).trim().slice(0, 120) || "(empty)";
    }
    criteria.none = "No line here answers it.";
    questions[`where_${w}`] = {
      type: "choice",
      instructions: `Which line of \`page\` (from ${id(w * WINDOW)} to ${id(Math.min(lines.length, (w + 1) * WINDOW) - 1)}) best answers \`question\`?`,
      criteria,
    };
  }
  const answers = await input.judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "screen_find",
    state: { question: input.question.trim(), page: { address: input.observation.url, lines: numbered } },
    questions,
  });
  const exists = answers.answers?.noul ?? 0;
  const hits = new Set<number>();
  for (let w = 0; w < windows; w++) {
    const probs = answers[`where_${w}`]?.probabilities ?? {};
    for (const [key, p] of Object.entries(probs)) {
      const m = /^L(\d+)$/.exec(key);
      if (m && p >= 0.2) hits.add(Number(m[1]) - 1);
    }
    const choice = answers[`where_${w}`]?.choice;
    const m = choice ? /^L(\d+)$/.exec(choice) : null;
    if (m && (probs[choice as string] ?? 0) >= 0.5) hits.add(Number(m[1]) - 1);
  }
  const keep = new Set<number>();
  for (const i of [...hits].sort((a, b) => a - b).slice(0, 8)) {
    for (let k = Math.max(0, i - AROUND); k <= Math.min(lines.length - 1, i + AROUND); k++) keep.add(k);
  }
  const out: string[] = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== prev + 1 && out.length > 0) out.push("…");
    out.push(lines[i] as string);
    prev = i;
  }
  const text = out.join("\n").slice(0, input.maxChars ?? 6000);
  const answered = exists >= 0.7 && text ? "yes" : exists >= 0.35 && text ? "partly" : "no";
  return { answered, text };
}

/** A dismiss is clicked from this probability: it must clearly be one. */
const DISMISS_AT = 0.7;

/**
 * Something covers the page where the agent clicked (a cookie banner, a
 * dialog): the control that closes it without agreeing to more than needed,
 * or null. Never one that buys, signs up, accepts terms or grants anything.
 */
export async function findDismiss(
  input: Ids & { observation: ScreenObservation; covering: string },
): Promise<ScreenElement | null> {
  const pool = input.observation.elements.filter((e) => e.role === "button" || e.role === "link").slice(0, 200);
  if (pool.length === 0) return null;
  const criteria: Record<string, string> = {};
  for (const e of pool) criteria[e.ref] = describeElement(e);
  criteria.none = "None of these just closes it.";
  const answers = await input.judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "screen_dismiss",
    state: { covering: input.covering.slice(0, 300), screen: { address: input.observation.url } },
    questions: {
      close: {
        type: "choice",
        instructions:
          "`covering` (a banner or dialog) is in the way of the page. Which control only closes it, agreeing to no more than needed: Close, ×, Not now, Reject optional cookies, Continue without accepting? Never one that buys, subscribes, signs up, accepts terms or grants permissions.",
        criteria,
      },
    },
  });
  const choice = answers.close?.choice;
  const p = choice ? (answers.close?.probabilities?.[choice] ?? 0) : 0;
  if (!choice || choice === "none" || p < DISMISS_AT) return null;
  return pool.find((e) => e.ref === choice) ?? null;
}
