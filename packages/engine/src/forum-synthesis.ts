/**
 * The forum's text formats (D45): the stance line an agent starts its post
 * with, and the synthesis in two formats ("decision" or "plan"). The model
 * writes markdown with fixed English headings; these parsers turn it into
 * the structured cards the app shows. They are lenient: a missing section is
 * empty, never an error.
 */

export type ForumFormat = "decision" | "plan";
export const FORUM_FORMATS: readonly ForumFormat[] = ["decision", "plan"];

export type ForumStanceKind = "propose" | "agree" | "disagree" | "shift" | "ask" | "reply";

/** Who a stance points at, resolved to an id when the handle is known. */
export interface ForumStanceTarget {
  type: "agent" | "person" | "people";
  id?: string;
  handle?: string;
}

export interface ForumStance {
  kind: ForumStanceKind;
  target?: ForumStanceTarget;
}

/** A post's header, as the agent wrote it (handles not resolved yet). */
export interface ForumPostHeader {
  /** The post without its header lines. */
  body: string;
  stance: { kind: ForumStanceKind; handle?: string; people?: boolean } | null;
  /** `@handle` or a post id. */
  replyTo: string | null;
  /** The agent's position in one line ("Onde cada um está"). */
  position: string | null;
}

const STANCE_WORDS: [RegExp, ForumStanceKind][] = [
  [/^propos/i, "propose"],
  [/^disagree/i, "disagree"],
  [/^agree/i, "agree"],
  [/^(change|shift)/i, "shift"],
  [/^ask/i, "ask"],
  [/^(answer|repl|respond)/i, "reply"],
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function stanceOf(value: string): ForumPostHeader["stance"] {
  const word = value.trim().split(/\s+/)[0] ?? "";
  const kind = STANCE_WORDS.find(([re]) => re.test(word))?.[1];
  if (!kind) return null;
  const handle = /@([a-z0-9_-]+)/i.exec(value)?.[1]?.toLowerCase();
  const people = !handle && /\b(people|everyone|the team|pessoas|todos)\b/i.test(value);
  return { kind, ...(handle ? { handle } : {}), ...(people ? { people: true } : {}) };
}

/**
 * Reads the header an agent's forum post starts with:
 * `Stance: agrees @ada`, then optionally `Replying to: @theo` (or a post id)
 * and `Position: <one line>`. Markdown emphasis around the labels is fine.
 * The header lines are taken out of the body.
 */
export function splitStance(text: string): ForumPostHeader {
  const lines = text.split("\n");
  let stance: ForumPostHeader["stance"] = null;
  let replyTo: string | null = null;
  let position: string | null = null;
  let consumed = 0;
  for (let i = 0; i < lines.length && i < 10; i++) {
    const line = (lines[i] ?? "").replace(/[*_>`]/g, "").trim();
    if (!line) continue;
    const m = /^(stance|position|replying to|reply to|in reply to)\s*:\s*(.*)$/i.exec(line);
    if (!m) break;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "stance") stance = stanceOf(value);
    else if (key === "position") position = value.slice(0, 300) || null;
    else replyTo = UUID.exec(value)?.[0] ?? (/@[a-z0-9_-]+/i.exec(value)?.[0]?.toLowerCase() || null);
    consumed = i + 1;
  }
  if (consumed === 0) return { body: text, stance: null, replyTo: null, position: null };
  const rest = lines.slice(consumed).join("\n").trim();
  return { body: rest || text.trim(), stance, replyTo, position };
}

// ── Synthesis ────────────────────────────────────────────────────────────────

export interface ForumOwner {
  type: "agent" | "person";
  id: string;
}

export interface ForumSuggestedIssue {
  title: string;
  description: string;
  /** The plan step it comes from (1-based). */
  step?: number;
  owner?: ForumOwner | null;
}

export interface ForumDecisionSynthesis {
  format: "decision";
  /** One short sentence. */
  decision: string;
  /** Why it was decided, one short line each. */
  reasons: string[];
  positions: { agentId: string | null; name: string; pros: string[]; cons: string[] }[];
  openQuestions: string[];
  nextSteps: { text: string; owner: ForumOwner | null; ownerLabel: string | null; when: string | null }[];
  suggestedIssues: ForumSuggestedIssue[];
  /** A rewritten synthesis (version 2+): what changed. */
  changes: string[];
}

export interface ForumPlanSynthesis {
  format: "plan";
  objective: string;
  summaryForRequester: string;
  inScope: string[];
  outOfScope: string[];
  steps: {
    title: string;
    owner: ForumOwner | null;
    ownerLabel: string | null;
    after: number | null;
    size: string | null;
  }[];
  risks: string[];
  metrics: string[];
  openQuestions: string[];
  suggestedIssues: ForumSuggestedIssue[];
  changes: string[];
}

export type ForumSynthesis = ForumDecisionSynthesis | ForumPlanSynthesis;

/** Turns an owner as written ("@ada", "Marina") into an agent or a person of the org, or null. */
export type OwnerResolver = (label: string) => ForumOwner | null;

const clean = (s: string) =>
  s
    .replace(/\*\*|__/g, "")
    // Quotes around the whole line go; inline code stays (the app renders it).
    .replace(/^(["'])(.*)\1$/s, "$2")
    .trim();
const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/[*_`#:.]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function splitSections(markdown: string) {
  const out: { title: string; body: string }[] = [];
  let title = "";
  let body: string[] = [];
  for (const line of markdown.split("\n")) {
    const h = /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ title, body: body.join("\n").trim() });
      title = norm(h[1] ?? "");
      body = [];
      continue;
    }
    body.push(line);
  }
  out.push({ title, body: body.join("\n").trim() });
  return out;
}

function sectionOf(sections: { title: string; body: string }[], names: string[]): string {
  return sections.find((s) => s.title && names.some((n) => s.title === n || s.title.startsWith(n)))?.body ?? "";
}

/** The items of a list section (bullets or numbers); plain lines when there are no bullets. */
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/;

function items(text: string, max = 30): string[] {
  const lines = text.split("\n").filter((l) => l.trim() && !/^\s*#/.test(l));
  const bullets = lines.flatMap((l) => {
    const m = BULLET.exec(l);
    return m?.[1] ? [clean(m[1])] : [];
  });
  return (bullets.length > 0 ? bullets : lines.map(clean)).filter(Boolean).slice(0, max);
}

const paragraph = (text: string) =>
  clean(
    text
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join(" ")
      .replace(/\s+/g, " "),
  ).slice(0, 4000);

const firstParagraph = (markdown: string) =>
  paragraph(
    markdown
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !/^\s*#/.test(p)) ?? "",
  );

const PARTS = /\s+[—–|]\s+/;

/** "Title — description (step 2, owner: @ada)" lines of the "Suggested issues" section (older syntheses: "Issues sugeridas"). */
export function parseSuggestedIssues(markdown: string, resolve?: OwnerResolver): ForumSuggestedIssue[] {
  const section = /#+\s*(?:suggested issues|issues sugeridas)\s*\n([\s\S]*?)(?:\n#+\s|$)/i.exec(markdown)?.[1] ?? "";
  return section
    .split("\n")
    .map((l) => /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 10)
    .map((raw) => {
      let line = raw;
      let step: number | undefined;
      let ownerLabel: string | undefined;
      const extra = /\(([^()]*\b(?:step|owner|etapa|dono)\b[^()]*)\)\s*$/i.exec(line);
      if (extra) {
        line = line.slice(0, extra.index).trim();
        const s = /(?:step|etapa)\s*#?(\d+)/i.exec(extra[1] ?? "")?.[1];
        if (s) step = Number(s);
        ownerLabel = /(?:owner|dono)\s*:\s*([^,;)]+)/i.exec(extra[1] ?? "")?.[1]?.trim();
      }
      const parts = line.split(PARTS).filter((p) => {
        const s = /^(?:step|etapa)\s*:?\s*#?(\d+)$/i.exec(p.trim());
        if (s) step = Number(s[1]);
        const o = /^(?:owner|dono)\s*:\s*(.+)$/i.exec(p.trim());
        if (o) ownerLabel = o[1]?.trim();
        return !s && !o;
      });
      const [title, ...rest] = parts;
      const owner = ownerLabel && resolve ? resolve(ownerLabel) : null;
      return {
        title: clean(title ?? line).slice(0, 200),
        description: rest.join(" — ").trim(),
        ...(step && Number.isFinite(step) ? { step } : {}),
        ...(ownerLabel ? { owner } : {}),
      };
    });
}

function ownerOf(label: string | null | undefined, resolve: OwnerResolver) {
  const l = clean(label ?? "");
  return l ? { owner: resolve(l), ownerLabel: l } : { owner: null, ownerLabel: null };
}

function parsePositions(text: string, resolve: OwnerResolver): ForumDecisionSynthesis["positions"] {
  const out: ForumDecisionSynthesis["positions"] = [];
  let current: ForumDecisionSynthesis["positions"][number] | null = null;
  for (const line of text.split("\n")) {
    const h = /^\s*#{3,6}\s+(.+?)\s*$/.exec(line);
    if (h) {
      const name = clean(h[1] ?? "");
      const who = resolve(name);
      current = { agentId: who?.type === "agent" ? who.id : null, name: name.replace(/^@/, ""), pros: [], cons: [] };
      out.push(current);
      continue;
    }
    const b = /^\s*[-*+•]\s+(.+)$/.exec(line)?.[1];
    if (!b || !current) continue;
    const item = clean(b);
    const con = /^(?:cons?|contras?|against)\s*:\s*(.+)$/i.exec(item)?.[1];
    const pro = /^(?:pros?|prós?|for)\s*:\s*(.+)$/i.exec(item)?.[1];
    if (con) current.cons.push(con.trim());
    else current.pros.push((pro ?? item).trim());
  }
  return out.slice(0, 12);
}

function parseNextSteps(text: string, resolve: OwnerResolver): ForumDecisionSynthesis["nextSteps"] {
  return items(text, 20).map((line) => {
    const m = /^(@[a-z0-9_-]+|[^:]{1,40}):\s+(.+)$/i.exec(line);
    const who = m ? ownerOf(m[1], resolve) : { owner: null, ownerLabel: null };
    const keep = m && (who.owner || (m[1] ?? "").startsWith("@"));
    const rest = keep ? (m?.[2] ?? line) : line;
    const parts = rest.split(PARTS);
    const when = parts.length > 1 ? (parts.pop() ?? null) : null;
    return { text: parts.join(" — ").trim(), ...(keep ? who : { owner: null, ownerLabel: null }), when };
  });
}

function parseSteps(text: string, resolve: OwnerResolver): ForumPlanSynthesis["steps"] {
  return items(text, 20).map((line) => {
    let owner: ForumOwner | null = null;
    let ownerLabel: string | null = null;
    let after: number | null = null;
    let size: string | null = null;
    const titleParts: string[] = [];
    for (const raw of line.split(PARTS)) {
      const p = raw.trim();
      const o = /^(?:owner|dono|responsible)\s*:\s*(.+)$/i.exec(p)?.[1];
      const a = /^(?:after|depends on|depois de)\s*:?\s*(?:step\s*|etapa\s*)?#?(\d+)/i.exec(p)?.[1];
      const s = /^(?:size|tamanho)\s*:\s*(.+)$/i.exec(p)?.[1];
      if (o) ({ owner, ownerLabel } = ownerOf(o, resolve));
      else if (a) after = Number(a);
      else if (s) size = clean(s);
      else if (!/^(?:after|depends on)\s*:?\s*(?:none|-|—)?$/i.test(p)) titleParts.push(p);
    }
    return { title: clean(titleParts.join(" — ")).slice(0, 300), owner, ownerLabel, after, size };
  });
}

/** The synthesis markdown as structured cards, in the topic's format. */
export function parseSynthesis(
  format: ForumFormat,
  markdown: string,
  resolve: OwnerResolver = () => null,
): ForumSynthesis {
  const sections = splitSections(markdown);
  const suggestedIssues = parseSuggestedIssues(markdown, resolve);
  const changes = items(sectionOf(sections, ["what changed", "o que mudou"]), 20);
  const openQuestions = items(sectionOf(sections, ["open questions", "perguntas em aberto"]), 20);
  if (format === "plan") {
    const objective = paragraph(sectionOf(sections, ["objective", "goal", "objetivo"])) || firstParagraph(markdown);
    return {
      format,
      objective,
      summaryForRequester: paragraph(
        sectionOf(sections, ["for the requester", "summary for the requester", "for whoever asked", "para quem pediu"]),
      ),
      inScope: items(sectionOf(sections, ["in scope", "what is in", "o que entra"])),
      outOfScope: items(sectionOf(sections, ["out of scope", "what is out", "o que fica de fora"])),
      steps: parseSteps(sectionOf(sections, ["steps", "etapas"]), resolve),
      risks: items(sectionOf(sections, ["risks", "riscos"])),
      metrics: items(sectionOf(sections, ["metrics", "how to measure", "measure", "como medir"])),
      openQuestions,
      suggestedIssues,
      changes,
    };
  }
  // The decision is a sentence; a list written under it (the reasoning) goes to the reasons.
  const decisionText = sectionOf(sections, ["decision", "recommendation", "decisão", "recomendação"]);
  const lines = decisionText.split("\n");
  const firstBullet = lines.findIndex((l) => BULLET.test(l));
  const lead = firstBullet < 0 ? decisionText : lines.slice(0, firstBullet).join("\n");
  const listed = firstBullet < 0 ? [] : items(lines.slice(firstBullet).join("\n"), 8);
  const why = items(sectionOf(sections, ["why", "reasons", "por quê", "por que", "motivos"]), 8);
  return {
    format: "decision",
    decision: paragraph(lead) || firstParagraph(markdown),
    reasons: why.length > 0 ? why : listed,
    positions: parsePositions(sectionOf(sections, ["pros and cons", "prós e contras"]), resolve),
    openQuestions,
    nextSteps: parseNextSteps(sectionOf(sections, ["next steps", "próximos passos"]), resolve),
    suggestedIssues,
    changes,
  };
}

/** The one-line summary of a synthesis (the decision, or the plan's objective). */
export const synthesisSummary = (s: ForumSynthesis) =>
  s.format === "plan" ? s.summaryForRequester || s.objective : s.decision;

/** What the owner agent is asked to write at the end. Headings stay in English (they are parsed). */
export function synthesisPrompt(input: {
  handle: string;
  title: string;
  format: ForumFormat;
  /** 2+ when a reopened topic rewrites it. */
  revision: number;
  requesterName?: string | null;
}): string {
  const intro = `@${input.handle}, now write the ${input.format === "plan" ? "plan" : "synthesis"} of the forum "${input.title}" for whoever asked${input.requesterName ? ` (${input.requesterName})` : ""}. Be faithful to what was said. Use exactly these markdown headings, in English (they are read by the app); write the content in the language of the forum's title, not of this message.${input.format === "plan" ? " Suggest one issue per step that needs work." : ""}`;
  const issues =
    input.format === "plan"
      ? "## Suggested issues\n- Title — description (step N, owner: @handle or person name)"
      : "## Suggested issues\n- Title — description (owner: @handle or person name)";
  const body =
    input.format === "plan"
      ? [
          "## Objective\nOne or two sentences.",
          "## For the requester\nA short summary in plain words for the person who asked.",
          "## In scope\n- …",
          "## Out of scope\n- …",
          "## Steps\n1. Step title — owner: @handle or person name — after: N (the step it depends on, if any) — size: ~1 day",
          "## Risks\n- …",
          "## Metrics\n- how to measure the result",
          "## Open questions\n- questions nobody answered (also the ones asked to people)",
          issues,
        ]
      : [
          "## Decision\nOne short sentence: what was decided (no list, no details; at most ~25 words).",
          "## Why\n- the main reasons, one short line each (up to 5)",
          "## Pros and cons\n### @handle (one per participant)\n- Pro: …\n- Con: …",
          "## Open questions\n- questions nobody answered (also the ones asked to people)",
          "## Next steps\n- @handle or person name: what — when",
          issues,
        ];
  const rewrite =
    input.revision > 1
      ? `\nThis rewrites your previous synthesis (it becomes version ${input.revision}) after the new round: keep what still holds, update what changed, and end with a "## What changed" section listing the changes (or "- Nothing changed in the decision").`
      : "";
  return `${intro}${rewrite}\n\n${body.join("\n\n")}${input.revision > 1 ? "\n\n## What changed\n- …" : ""}`;
}

/** What a discussion turn asks for (the stance header is parsed into the post's stance). */
export function turnPrompt(input: { handle: string; round: number; rounds: number; title: string; goal: string }) {
  return [
    `@${input.handle}, your turn in round ${input.round} of ${input.rounds} of the forum "${input.title}". Goal: ${input.goal}`,
    "Read what was already said, bring your view and data from your tools, disagree when you have a reason and talk to the others with @. One reply per round.",
    'Start your post with the line "Stance: proposes", "Stance: agrees @handle", "Stance: disagrees @handle", "Stance: changes" (you changed your position), "Stance: asks @handle" (or "asks people") or "Stance: answers @handle"; then, optionally, "Replying to: @handle" (whose post you answer) and "Position: <your position in one line>". Keep these labels in English; then write your post.',
    "Write your post in the language of the forum's title and goal, not of this message (always in English), even if earlier posts used another language.",
    "To ask the people something, ask it in your post (Stance: asks people): don't wait for an answer, the discussion goes on and what stays unanswered goes to the open questions.",
  ].join("\n");
}
