import type { AgentQuestion, Message, MessageConsultation, MessagePin, ReactionCount } from "@agenteschat/client";
import { previewOf } from "../shared/logic";

/**
 * The conversation screen's pure rules: which messages it shows and how they
 * group, what each message carries (cards from `meta`), the working line,
 * reactions, pins, the slash commands and a small Markdown reader.
 */

// ── Timeline ─────────────────────────────────────────────────────────────────

const byTime = (a: Pick<Message, "createdAt" | "id">, b: Pick<Message, "createdAt" | "id">) =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1;

/** Top-level messages plus loaded thread replies (agents answer inside the thread of the message that called them). */
export function mergeTimeline(topLevel: Message[], threads: (Message[] | undefined)[]): Message[] {
  const seen = new Map<string, Message>();
  for (const m of topLevel) seen.set(m.id, m);
  for (const list of threads) for (const m of list ?? []) seen.set(m.id, m);
  return [...seen.values()].sort(byTime);
}

/** Person messages whose replies (the agents' answers) are shown inline: the latest ones, not thread or mission roots. */
export function threadRootsToLoad(topLevel: Message[], skip: ReadonlySet<string>, max = 20): string[] {
  return topLevel
    .filter((m) => m.author.type === "person" && !skip.has(m.id) && !m.meta?.threadStart && !m.meta?.missionStart)
    .slice(-max)
    .map((m) => m.id);
}

export const GROUP_WINDOW_MS = 5 * 60_000;

/** Same author again within 5 minutes, nothing special in between: the row drops its name and avatar. */
export function groupsWith(prev: Pick<Message, "author" | "createdAt"> | null | undefined, m: Message) {
  if (!prev) return false;
  const gap = new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return prev.author.type === m.author.type && prev.author.id === m.author.id && gap >= 0 && gap < GROUP_WINDOW_MS;
}

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export type ChatRow =
  | { kind: "day"; key: string; iso: string }
  | { kind: "message"; key: string; message: Message; grouped: boolean };

/** A row's key: an optimistic message keeps it when the server copy (same `clientId`) replaces it. */
export const messageKey = (m: Pick<Message, "id" | "clientId">) => (m.clientId ? `c:${m.clientId}` : m.id);

/** A message that stands on its own (cards, consultations): nothing groups under it and it never groups. */
export function standsAlone(m: Message) {
  const meta = m.meta ?? {};
  return Boolean(
    meta.approvalId ||
      meta.missionPlan ||
      meta.missionReview ||
      meta.missionDecision ||
      meta.missionStart ||
      meta.missionLink ||
      meta.threadStart ||
      questionOf(meta) ||
      consultationsOf(meta).length > 0,
  );
}

/** Day dividers and messages, oldest first (the list draws them newest at the bottom). */
export function buildRows(messages: Message[], hidden: (m: Message) => boolean = () => false): ChatRow[] {
  const rows: ChatRow[] = [];
  let lastDay = "";
  let prev: Message | null = null;
  for (const m of [...messages].sort(byTime)) {
    if (hidden(m)) continue;
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `day-${day}`, iso: m.createdAt });
      lastDay = day;
      prev = null;
    }
    const grouped = !standsAlone(m) && !(prev && standsAlone(prev)) && groupsWith(prev, m);
    rows.push({ kind: "message", key: messageKey(m), message: m, grouped });
    prev = m;
  }
  return rows;
}

// ── What a message carries ───────────────────────────────────────────────────

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export const approvalIdOf = (meta: Message["meta"]) => str(meta?.approvalId) || null;

const STATUSES = new Set(["answered", "expired", "failed"]);

/** `meta.consulted`: the agents it asked before answering (bad entries left out). */
export function consultationsOf(meta: Message["meta"]): MessageConsultation[] {
  const list = meta?.consulted;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v): MessageConsultation[] => {
    const o = obj(v);
    if (!o || !str(o.agentId)) return [];
    const raw = str(o.status);
    const status = (STATUSES.has(raw) ? raw : "failed") as MessageConsultation["status"];
    const answer = status === "answered" && str(o.answer).trim() ? str(o.answer) : null;
    return [
      {
        agentId: str(o.agentId),
        consultationId: str(o.consultationId) || `${str(o.agentId)}:${status}`,
        status: status === "answered" && !answer ? "failed" : status,
        question: str(o.question),
        answer,
      },
    ];
  });
}

/** `meta.missionReview` / `missionDecision` / `missionDelivery`: the card's id and mission. */
export function missionCardRef(
  meta: Message["meta"],
  key: "missionDecision" | "missionReview" | "missionDelivery",
): { id: string; missionId: string } | null {
  const p = obj(meta?.[key]);
  return p && str(p.id) && str(p.missionId) ? { id: str(p.id), missionId: str(p.missionId) } : null;
}

/** `meta.missionPlan`: the plan card (Começar / Mudar algo). */
export function missionPlanOf(meta: Message["meta"]): { missionId: string; title: string; goal: string } | null {
  const p = obj(meta?.missionPlan);
  return p && str(p.missionId) ? { missionId: str(p.missionId), title: str(p.title), goal: str(p.goal) } : null;
}

/** `meta.missionLink`: the mission an agent's reply proposed, whose thread lives elsewhere. */
export function missionLinkOf(meta: Message["meta"]): { missionId: string; threadId: string } | null {
  const p = obj(meta?.missionLink);
  return p && str(p.missionId) && str(p.threadId) ? { missionId: str(p.missionId), threadId: str(p.threadId) } : null;
}

/** `meta.work`: how many steps the run took (the collapsed "N passos" header). */
export function workStepsOf(meta: Message["meta"]): number | null {
  const w = obj(meta?.work);
  return w && typeof w.steps === "number" && w.steps > 0 ? w.steps : null;
}

/** `meta.artifacts`: the files on a message. */
export function artifactsOf(
  meta: Message["meta"],
): { id: string; version?: number; title: string; deleted: boolean }[] {
  const list = meta?.artifacts;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r) => {
    const o = obj(r);
    if (!o || !str(o.id)) return [];
    return [
      {
        id: str(o.id),
        ...(typeof o.version === "number" ? { version: o.version } : {}),
        title: str(o.title),
        deleted: o.deleted === true,
      },
    ];
  });
}

/** `meta.question`: an agent's question (`ask_user`), with its choices and, once answered, the answer. */
export function questionOf(meta: Message["meta"]): AgentQuestion | null {
  const q = obj(meta?.question);
  if (!q || !str(q.id) || !str(q.text) || !str(q.agentId)) return null;
  const choices = Array.isArray(q.choices) ? q.choices.filter((c): c is string => typeof c === "string" && !!c) : [];
  return {
    id: str(q.id),
    agentId: str(q.agentId),
    channelId: str(q.channelId),
    threadId: str(q.threadId) || null,
    messageId: str(q.messageId) || null,
    text: str(q.text),
    choices: choices.length > 0 ? choices : null,
    status: q.status === "answered" ? "answered" : "open",
    answer: str(q.answer) || null,
    answeredByUserId: str(q.answeredByUserId) || null,
  };
}

/** A message the person never needs to read as text (the card says it all; a question's card repeats it). */
export const hidesBody = (m: Message) =>
  Boolean(
    approvalIdOf(m.meta) ||
      m.meta?.missionStart ||
      m.meta?.threadStart ||
      questionOf(m.meta)?.text.trim() === m.body.trim(),
  );

// ── Live work ────────────────────────────────────────────────────────────────

/** One agent at work in the conversation (from the live runs and the questions it asked). */
export interface WorkingEntry {
  agentId: string;
  name: string;
  /** Asking another agent right now. */
  asking?: { agentId: string; name: string } | null;
}

/** The working line: what to say, with which names (the screen bolds the names). */
export type WorkingLine =
  | { key: "one"; params: { name: string } }
  | { key: "two"; params: { first: string; second: string } }
  | { key: "many"; params: { first: string; second: string; count: number } }
  | { key: "asking"; params: { from: string; to: string; toGender: "F" | "M" } };

/** "Theo está trabalhando…", "Theo e Iris…", "Theo, Iris e mais 2…", or "Dev está perguntando ao Infra…". */
export function workingLine(entries: WorkingEntry[], gender: (name: string) => "F" | "M"): WorkingLine | null {
  const unique = entries.filter((e, i) => entries.findIndex((x) => x.agentId === e.agentId) === i);
  if (unique.length === 0) return null;
  const asking = unique.find((e) => e.asking);
  if (unique.length === 1 && asking?.asking)
    return {
      key: "asking",
      params: { from: asking.name, to: asking.asking.name, toGender: gender(asking.asking.name) },
    };
  const [a, b] = unique;
  if (!a) return null;
  if (!b) return { key: "one", params: { name: a.name } };
  if (unique.length === 2) return { key: "two", params: { first: a.name, second: b.name } };
  return { key: "many", params: { first: a.name, second: b.name, count: unique.length - 2 } };
}

// ── Reactions ────────────────────────────────────────────────────────────────

/** The quick row in the long-press sheet. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "🙌", "👀"] as const;

/** `+1` / `-1` are stored by name (feedback to the agent); the pills show the emoji. */
const NAMED: Record<string, string> = { "+1": "👍", "-1": "👎" };
export const reactionEmoji = (reaction: string) => NAMED[reaction] ?? reaction;

/** What to send for an emoji: 👍 and 👎 go by name. */
export const reactionName = (emoji: string) => Object.entries(NAMED).find(([, e]) => e === emoji)?.[0] ?? emoji;

export interface ReactionPill {
  reaction: string;
  emoji: string;
  /** People who reacted (the count on the pill). */
  people: number;
  /** Agents who reacted (their faces on the pill). */
  agentIds: string[];
  mine: boolean;
}

/** People's pills show a count (mine outlined); an agent's reaction shows its face. */
export function reactionPills(reactions: ReactionCount[] | undefined, meId: string | null): ReactionPill[] {
  return (reactions ?? [])
    .map((r) => ({
      reaction: r.reaction,
      emoji: reactionEmoji(r.reaction),
      people: r.userIds.length,
      agentIds: r.agentIds ?? [],
      mine: meId ? r.userIds.includes(meId) : false,
    }))
    .filter((p) => p.people > 0 || p.agentIds.length > 0);
}

/** Toggle my reaction: the new list as the server will see it (optimistic). */
export function toggleReaction(
  reactions: ReactionCount[] | undefined,
  reaction: string,
  meId: string,
): ReactionCount[] {
  const list = reactions ?? [];
  const hit = list.find((r) => r.reaction === reaction);
  if (!hit) return [...list, { reaction, count: 1, userIds: [meId], agentIds: [] }];
  const mine = hit.userIds.includes(meId);
  const userIds = mine ? hit.userIds.filter((u) => u !== meId) : [...hit.userIds, meId];
  const next = { ...hit, userIds, count: Math.max(0, hit.count + (mine ? -1 : 1)) };
  return next.count === 0 && (next.agentIds?.length ?? 0) === 0
    ? list.filter((r) => r.reaction !== reaction)
    : list.map((r) => (r.reaction === reaction ? next : r));
}

// ── Pins ─────────────────────────────────────────────────────────────────────

/** "Fixadas": one entry per message, the latest pin first (the server's order, kept even if events raced). */
export function orderPins(pins: MessagePin[]): MessagePin[] {
  const latest = new Map<string, MessagePin>();
  for (const p of pins) {
    const had = latest.get(p.messageId);
    if (!had || had.pinnedAt < p.pinnedAt) latest.set(p.messageId, p);
  }
  return [...latest.values()].sort((a, b) =>
    a.pinnedAt === b.pinnedAt
      ? b.message.createdAt.localeCompare(a.message.createdAt)
      : b.pinnedAt.localeCompare(a.pinnedAt),
  );
}

/**
 * Tapping a pin: scroll to it when it is a row on screen, else open its
 * thread (a top-level message opens as the start of its own thread).
 */
export function pinTarget(
  pin: Pick<MessagePin, "messageId" | "threadId">,
  onScreen: ReadonlySet<string>,
): { kind: "scroll"; messageId: string } | { kind: "open"; threadId: string } {
  if (onScreen.has(pin.messageId)) return { kind: "scroll", messageId: pin.messageId };
  return { kind: "open", threadId: pin.threadId ?? pin.messageId };
}

// ── Composer ─────────────────────────────────────────────────────────────────

/** Slash commands (English identifiers in every language). */
export const SLASH_COMMANDS = ["mission", "summary", "remind", "plan", "pause", "resume", "stop"] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export function parseSlash(text: string): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const command = m[1] as SlashCommand;
  if (!SLASH_COMMANDS.includes(command)) return null;
  return { command, arg: (m[2] ?? "").trim() };
}

/** The title of a new thread from the message it starts at: its first words. */
export function threadTitleFrom(body: string, words = 6) {
  const text = previewOf(body);
  const cut = text.split(" ").slice(0, words).join(" ");
  return cut.replace(/[.,:;!?]+$/, "");
}

/** Faces of a thread link: distinct people and agents who wrote, up to `max`. */
export function threadFaces<T extends { type: string; id: string | null }>(participants: T[], max = 2): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of participants) {
    if (!p.id) continue;
    const k = `${p.type}:${p.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length === max) break;
  }
  return out;
}

// ── Markdown (what agents write) ─────────────────────────────────────────────

export type Inline = { kind: "text" | "bold" | "italic" | "code" | "mention"; text: string };
export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; inline: Inline[] }
  | { kind: "bullet"; inline: Inline[]; ordinal: string | null }
  | { kind: "quote"; inline: Inline[] }
  | { kind: "code"; text: string };

const MENTION = /(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![\w@-])/g;

function mentions(text: string, out: Inline[], kind: "text" | "bold" | "italic") {
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const prefix = match[1] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    if (start > last) out.push({ kind, text: text.slice(last, start) });
    out.push({ kind: "mention", text: `@${match[2] ?? ""}` });
    last = start + 1 + (match[2]?.length ?? 0);
  }
  if (last < text.length) out.push({ kind, text: text.slice(last) });
}

/** Inline marks: `code`, **bold**, *italic* / _italic_, links as their text, @mentions. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const clean = text.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)/g;
  let last = 0;
  for (const m of clean.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) mentions(clean.slice(last, at), out, "text");
    const tok = m[0];
    if (m[1]) out.push({ kind: "code", text: tok.slice(1, -1) });
    else if (m[2]) mentions(tok.slice(2, -2), out, "bold");
    else mentions(tok.slice(1, -1), out, "italic");
    last = at + tok.length;
  }
  if (last < clean.length) mentions(clean.slice(last), out, "text");
  return out.reduce<Inline[]>((acc, tok) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.kind === tok.kind && tok.kind !== "mention" && tok.kind !== "code") prev.text += tok.text;
    else if (tok.text) acc.push({ ...tok });
    return acc;
  }, []);
}

/** Blocks: fenced code, headings, lists, quotes and paragraphs (lines of a paragraph keep their breaks). */
export function parseBlocks(body: string): Block[] {
  const out: Block[] = [];
  const parts = body.split(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g);
  parts.forEach((chunk, i) => {
    if (i % 2 === 1) {
      out.push({ kind: "code", text: chunk.replace(/\n$/, "") });
      return;
    }
    let para: string[] = [];
    const flush = () => {
      if (para.length) out.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
      para = [];
    };
    for (const raw of chunk.split("\n")) {
      const line = raw.trimEnd();
      if (!line.trim()) {
        flush();
        continue;
      }
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const bullet = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
      const quote = /^>\s?(.*)$/.exec(line);
      if (heading) {
        flush();
        out.push({ kind: "heading", inline: parseInline(heading[1] ?? "") });
      } else if (bullet) {
        flush();
        out.push({ kind: "bullet", inline: parseInline(bullet[2] ?? ""), ordinal: bullet[1] ?? null });
      } else if (quote) {
        flush();
        out.push({ kind: "quote", inline: parseInline(quote[1] ?? "") });
      } else para.push(line);
    }
    flush();
  });
  return out;
}
