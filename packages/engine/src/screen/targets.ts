import { randomUUID } from "node:crypto";
import type { Judge, JudgeAnswer, JudgeQuestion } from "../judge";
import {
  describeElement,
  type ScreenElement,
  type ScreenImage,
  type ScreenObservation,
  screenRef,
} from "./observation";

/**
 * Targets in words (ADR 0054): the agent says "the Sign in button" instead of
 * reading the screen and copying a number. Code finds it, cheapest first:
 *
 * 1. a ref (`e12`) as given;
 * 2. one element whose name is exactly the words (no judge);
 * 3. what the same words found on this site before (the target cache);
 * 4. the judge picks among the screen's elements (a Choice over refs, plus
 *    whether it's there at all);
 * 5. on an image of the screen, when the text has nothing that fits (`locate`).
 *
 * The judge only points at something already on the screen; it never decides
 * whether the agent may act.
 */

/** What an action needs its target to be: only fitting elements are offered. */
export type TargetUse = "click" | "fill" | "select" | "check" | "type_secret" | "upload" | "hover";

const FIELDS = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textarea"]);
const ROLES: Partial<Record<TargetUse, ReadonlySet<string>>> = {
  fill: FIELDS,
  type_secret: new Set(["textbox"]),
  select: new Set(["combobox", "listbox"]),
  check: new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]),
};
/** Controls, as opposed to text with a ref (a heading "Sign in" next to the button "Sign in"). */
const CONTROLS = new Set([
  ...FIELDS,
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
  "listbox",
  "slider",
  "treeitem",
]);

export type TargetFound = {
  found: true;
  ref: string;
  element: ScreenElement | null;
  via: "ref" | "exact" | "cache" | "judge";
  confidence: number;
};
export type TargetMissing = {
  found: false;
  /** `unsure`: several fit; `absent`: nothing on the screen fits. */
  reason: "unsure" | "absent";
  candidates: ScreenElement[];
};
export type TargetResult = TargetFound | TargetMissing;

/** What a target's words found on a site, to find it again without the judge. */
export interface TargetMemory {
  role: string;
  name: string;
  /** Where it sat (its named containers): it is found again only there ("Delete" in the row for invoice 42). */
  context: string[];
}

/** In-process memory of targets per agent and site (LRU). */
export interface TargetCache {
  get(key: string): TargetMemory | undefined;
  set(key: string, value: TargetMemory): void;
}

export function createTargetCache(max = 2000): TargetCache {
  const map = new Map<string, TargetMemory>();
  return {
    get(key) {
      const v = map.get(key);
      if (v) {
        map.delete(key);
        map.set(key, v);
      }
      return v;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value as string);
    },
  };
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/["'`“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The page a target belongs to, with ids in the path generalized (`/orders/:id`). */
export function pageKey(url: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((p) => (/^\d+$|^[0-9a-f-]{8,}$|^[A-Za-z0-9_-]{20,}$/i.test(p) ? ":id" : p))
      .join("/");
    return `${u.host}${path}`;
  } catch {
    return url.slice(0, 200);
  }
}

export const targetKey = (scope: string, url: string | null, use: TargetUse, words: string) =>
  `${scope}|${pageKey(url)}|${use}|${normalize(words)}`;

const fits = (use: TargetUse, e: ScreenElement) => ROLES[use]?.has(e.role) ?? true;

/** The elements an action may target, best guesses first when there are too many for one question. */
function candidatesFor(words: string, use: TargetUse, o: ScreenObservation, max: number): ScreenElement[] {
  const fitting = o.elements.filter((e) => fits(use, e));
  const pool = fitting.length > 0 ? fitting : o.elements;
  if (pool.length <= max) return pool;
  const terms = normalize(words)
    .split(" ")
    .filter((t) => t.length > 1);
  const scored = pool.map((e) => {
    const text = normalize(`${e.role} ${e.name} ${e.context.join(" ")}`);
    return { e, score: terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0) };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.e.index - b.e.index)
    .slice(0, max)
    .map((s) => s.e)
    .sort((a, b) => a.index - b.index);
}

/** The one element with exactly these words as its name (and a fitting role), if there is exactly one. */
function exactMatch(words: string, use: TargetUse, o: ScreenObservation): ScreenElement | null {
  const w = normalize(words.replace(/^(the|o|a|os|as)\s+/i, ""));
  if (!w) return null;
  const same = o.elements.filter((e) => fits(use, e) && normalize(e.name) === w);
  if (same.length === 1) return same[0] as ScreenElement;
  // The same name on a heading and a button: the button is what one acts on.
  const controls = same.filter((e) => CONTROLS.has(e.role));
  if (controls.length === 1) return controls[0] as ScreenElement;
  // `button "Save"` written out.
  const m = /^([a-z]+)\s+"(.+)"$/i.exec(words.trim());
  if (m) {
    const role = (m[1] as string).toLowerCase();
    const name = normalize(m[2] as string);
    const hits = o.elements.filter((e) => e.role.toLowerCase() === role && normalize(e.name) === name);
    if (hits.length === 1) return hits[0] as ScreenElement;
  }
  return null;
}

/** The one element with the remembered role, name and place; none or several: the judge decides again. */
function fromMemory(memory: TargetMemory, o: ScreenObservation): ScreenElement | null {
  const place = memory.context.join(" › ");
  const same = o.elements.filter(
    (e) => e.role === memory.role && e.name === memory.name && e.context.join(" › ") === place,
  );
  return same.length === 1 ? (same[0] as ScreenElement) : null;
}

const memoryOf = (e: ScreenElement): TargetMemory => ({ role: e.role, name: e.name, context: e.context });

/** Most options one Choice offers (Jev takes 255, one is "none"). */
const MAX_OPTIONS = 200;
/** The judge's pick is taken from this probability, this far ahead of the next one. */
export const PICK_AT = 0.55;
const PICK_MARGIN = 0.2;
/**
 * An element whose wrong pick costs (it pays, deletes, sends): the judge must be this sure,
 * else the closest ones go back to the agent, which picks by number.
 */
export const COSTLY_PICK_AT = 0.85;
const COSTLY =
  /\b(delete|remove|erase|destroy|pay|purchase|buy|place order|checkout|send|transfer|confirm|unsubscribe|close account|cancel (my )?(account|subscription|plan)|excluir|apagar|remover|pagar|comprar|finalizar|enviar|transferir|confirmar|encerrar|cancelar (a )?(conta|assinatura|plano))\b/i;
/** A plain "Yes" or "OK" does what its dialog asks ("Delete project Acme?"): costly when the dialog is. */
const isCostly = (e: ScreenElement) =>
  COSTLY.test(e.name) || e.context.some((c) => /^(?:alert)?dialog "/.test(c) && COSTLY.test(c));
/** Below this, nothing on the screen is it. */
const ABSENT_BELOW = 0.3;

export interface ResolveInput {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
  /** The ref or the words, as the agent gave them. */
  target: string;
  use: TargetUse;
  observation: ScreenObservation;
  cache?: TargetCache;
  /** Who the cache is for (the agent's browser): one agent's sites never steer another's. */
  scope: string;
}

/** Finds the element the agent means (see the file's comment for the order). */
export async function resolveTarget(input: ResolveInput): Promise<TargetResult> {
  const { observation: o } = input;
  const ref = screenRef(input.target);
  if (ref) {
    return {
      found: true,
      ref,
      element: o.elements.find((e) => e.ref === ref) ?? null,
      via: "ref",
      confidence: 1,
    };
  }
  const words = input.target.trim();
  const exact = exactMatch(words, input.use, o);
  if (exact) return { found: true, ref: exact.ref, element: exact, via: "exact", confidence: 1 };
  const key = targetKey(input.scope, o.url, input.use, words);
  const remembered = input.cache?.get(key);
  const again = remembered ? fromMemory(remembered, o) : null;
  if (again) return { found: true, ref: again.ref, element: again, via: "cache", confidence: 1 };

  const candidates = candidatesFor(words, input.use, o, MAX_OPTIONS);
  if (candidates.length === 0) return { found: false, reason: "absent", candidates: [] };
  const criteria: Record<string, string> = {};
  for (const e of candidates) criteria[e.ref] = describeElement(e);
  criteria.none = "None of these elements is it.";
  const questions: Record<string, JudgeQuestion> = {
    which: {
      type: "choice",
      instructions:
        "An agent is working on `screen` and wants to act on `target`. Which element is the one it means? Judge by what each element is, its name and where it sits.",
      criteria,
    },
    present: {
      type: "noul",
      instructions: "Is `target` one of the elements on `screen`?",
      criteria: {
        true: "One element on the screen is clearly what `target` describes.",
        false: "Nothing on the screen is what `target` describes, or it can't be told apart from others.",
      },
    },
  };
  let answers: Record<string, JudgeAnswer>;
  try {
    answers = await input.judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "screen_target",
      // The pick is taken on its probabilities (the margin, 0.85 for costly ones): only a calibrated
      // judge answers. The cheap model would say 1 to anything.
      calibrated: true,
      state: {
        target: words,
        action: input.use,
        screen: { address: o.url, elements: candidates.map((e) => `${e.ref}: ${describeElement(e)}`).join("\n") },
      },
      questions,
    });
  } catch {
    // No calibrated judge (or it failed): the closest by their words go back, and the agent picks by number.
    return { found: false, reason: "unsure", candidates: closestByWords(words, candidates) };
  }
  return decide(answers, candidates, (picked) => {
    input.cache?.set(key, memoryOf(picked));
  });
}

/**
 * The three elements that share the most words with the target: its name counts most, then its
 * role, then where it sits; a control comes before text with the same words.
 */
function closestByWords(words: string, candidates: ScreenElement[]): ScreenElement[] {
  const terms = normalize(words)
    .split(" ")
    .filter((t) => t.length > 1);
  const hits = (text: string) => terms.filter((t) => normalize(text).includes(t)).length;
  return candidates
    .map((e) => ({
      e,
      score: 2 * hits(e.name) + hits(e.role) + 0.5 * hits(e.context.join(" ")) + (CONTROLS.has(e.role) ? 0.5 : 0),
    }))
    .filter((s) => s.score > 0.5)
    .sort((a, b) => b.score - a.score || a.e.index - b.e.index)
    .slice(0, 3)
    .map((s) => s.e);
}

function decide(
  answers: Record<string, JudgeAnswer>,
  candidates: ScreenElement[],
  remember: (e: ScreenElement) => void,
): TargetResult {
  const which = answers.which;
  const probabilities = which?.probabilities ?? {};
  const present = answers.present?.noul ?? 0;
  const ranked = candidates
    .map((e) => ({ e, p: probabilities[e.ref] ?? 0 }))
    .filter((r) => r.p > 0.02)
    .sort((a, b) => b.p - a.p);
  const choice = which?.choice;
  const picked = choice && choice !== "none" ? candidates.find((e) => e.ref === choice) : undefined;
  const p = choice ? (probabilities[choice] ?? 0) : 0;
  // The pick must stand out: ahead of the next element (or of "none").
  const next = Math.max(
    ranked.find((r) => r.e.ref !== choice)?.p ?? 0,
    choice === "none" ? 0 : (probabilities.none ?? 0),
  );
  // Elements that read the same can't be told apart, whatever the judge says: the agent picks by number.
  const twins = picked ? candidates.filter((e) => e !== picked && describeElement(e) === describeElement(picked)) : [];
  if (picked && twins.length > 0) {
    return { found: false, reason: "unsure", candidates: [picked, ...twins].slice(0, 3) };
  }
  const need = picked && isCostly(picked) ? COSTLY_PICK_AT : PICK_AT;
  if (picked && p >= need && p - next >= PICK_MARGIN && present >= ABSENT_BELOW) {
    remember(picked);
    return { found: true, ref: picked.ref, element: picked, via: "judge", confidence: p };
  }
  const top = ranked.slice(0, 3).map((r) => r.e);
  if (present < ABSENT_BELOW || (choice === "none" && p >= PICK_AT)) {
    return { found: false, reason: "absent", candidates: top };
  }
  return { found: false, reason: "unsure", candidates: top };
}

/** Where a target is on an image of the screen (CSS pixels of the page), with the element there if marked. */
export type Located =
  | { found: true; x: number; y: number; ref: string | null; confidence: number }
  | { found: false; reason: string };

/**
 * Looks for the target on an image of the screen (Jev's Box, plus whether it's
 * there). With marks (an annotated screenshot), the point lands on a marked
 * element's ref, so the action stays as exact as a ref; else it's a point.
 */
export async function locateOnImage(input: {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
  target: string;
  image: ScreenImage;
  url?: string | null;
}): Promise<Located> {
  const placeholder = `screen_${randomUUID()}`;
  let answers: Record<string, JudgeAnswer>;
  try {
    answers = await input.judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "screen_locate",
      state: { screenshot: placeholder, address: input.url ?? null, target: input.target.trim() },
      images: { [placeholder]: { data: input.image.data, format: "jpeg" } },
      questions: {
        where: {
          type: "box",
          instructions:
            "In `screenshot` (a web page), box the one control that does what `target` describes, tightly. It may be only an icon: a gear for settings, a trash can for delete, a pencil for edit, a magnifier for search, × for close.",
        },
        present: {
          type: "noul",
          instructions: "Does `screenshot` show a control that does what `target` describes (maybe only as an icon)?",
          criteria: {
            true: "It is visible on the screenshot.",
            false: "It isn't on the screenshot (hidden, scrolled away or not on this page).",
          },
        },
      },
    });
  } catch (error) {
    return { found: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const box = answers.where?.box;
  const present = answers.present?.noul ?? 0;
  if (!box || present < 0.6) return { found: false, reason: "not on the screen" };
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  // A box over most of the image isn't an element.
  if (w <= 0 || h <= 0 || w * h > 0.4) return { found: false, reason: "no clear element there" };
  const x = Math.round(((box.left + box.right) / 2) * input.image.viewport.width);
  const y = Math.round(((box.top + box.bottom) / 2) * input.image.viewport.height);
  const hit = (input.image.marks ?? [])
    .filter((m) => x >= m.box.x && x <= m.box.x + m.box.width && y >= m.box.y && y <= m.box.y + m.box.height)
    .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0];
  return { found: true, x, y, ref: hit?.ref ?? null, confidence: present };
}
