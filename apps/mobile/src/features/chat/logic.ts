import type {
  AgentQuestion,
  LiveConsult,
  LiveRun,
  Message,
  MessageConsultation,
  MessagePin,
  ReactionCount,
} from "@agenteschat/client";
import { agentProposalOf } from "@agenteschat/client/lib/action-cards";
import { type ActivityEntry, barEntries } from "@agenteschat/client/lib/activity";
import { type TableAlign, tableAt } from "@agenteschat/client/lib/markdown";
import {
  answeredNotices,
  followUpLine,
  isAnsweredNotice,
  isEventLine,
  isTalkerReply,
  noticeAgentHandle,
  noticeOf,
  noticeRoutineName,
} from "@agenteschat/client/lib/notices";
import { isRoutineCall, routineReplyOf } from "@agenteschat/client/lib/routines";
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
      meta.missionSetup ||
      meta.missionStart ||
      meta.missionLink ||
      meta.threadStart ||
      meta.issueWork ||
      meta.issueTaken ||
      questionOf(meta) ||
      consultationsOf(meta).length > 0 ||
      routineReplyOf(m) ||
      isEventLine(meta),
  );
}

/**
 * Day dividers and messages, oldest first (the list draws them newest at the bottom). What a routine
 * found, told by its agent, stands alone with its own header; the report it answers folds into it, and a
 * routine's call written as its creator is left out, like the web's `buildTimeline`.
 */
export function buildRows(messages: Message[], hidden: (m: Message) => boolean = () => false): ChatRow[] {
  const rows: ChatRow[] = [];
  let lastDay = "";
  let prev: Message | null = null;
  const answered = answeredNotices(messages);
  for (const m of [...messages].sort(byTime)) {
    if (hidden(m) || isRoutineCall(m) || isAnsweredNotice(m, answered)) continue;
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `day-${day}`, iso: m.createdAt });
      lastDay = day;
      prev = null;
    }
    // A fast reply while its task works keeps its header ("enquanto trabalha"), as on the web.
    const grouped = !standsAlone(m) && !(prev && standsAlone(prev)) && !isTalkerReply(m.meta) && groupsWith(prev, m);
    rows.push({ kind: "message", key: messageKey(m), message: m, grouped });
    prev = m;
  }
  return rows;
}

// ── Automatic lines ──────────────────────────────────────────────────────────

/**
 * One quiet line instead of a voice (the web's `ChatNotices`): what reached an agent's conversation
 * (`meta.notice`: "Rotina «X» entregou um relatório" while nobody answered it yet, "@Infra respondeu",
 * "Nota de @Dev", "Chegou o resultado que Ada esperava"); the text on demand. `key`/`values` are the
 * shared i18n (`chat.notice.*`). A talker reply is never one: it shows as the agent's message
 * (`noticeOf` leaves it out).
 */
export interface EventLineView {
  kind: "notice";
  icon: "clock" | "agent" | "chat" | "check" | "bell";
  key: string;
  values: Record<string, string>;
  /** Shown on "Ver": the message's text, else the notice's. */
  text: string;
}

const NOTICE_ICON: Record<string, EventLineView["icon"]> = {
  routine_handoff: "clock",
  consult_reply: "agent",
  agent_note: "chat",
  wait_result: "check",
  follow_up: "clock",
};

export function eventLineOf(
  m: Pick<Message, "body" | "meta">,
  names: { author: string; agentByHandle: (handle: string) => string | null },
  /** A follow-up's time for the reader ("18:30"), and the reader's locale for its day. */
  when: { time: (iso: string) => string; locale: string } = { time: (iso) => iso, locale: "pt-BR" },
): EventLineView | null {
  const notice = noticeOf(m.meta);
  if (!notice) return null;
  const handle = noticeAgentHandle(notice);
  // `from` is written for the agent ("@infra"): the app says the agent's name, without the @.
  const from = handle ? (names.agentByHandle(handle) ?? handle) : notice.from;
  const icon = NOTICE_ICON[notice.kind] ?? "bell";
  const line = (key: string, values: Record<string, string> = {}): EventLineView => ({
    kind: "notice",
    icon,
    key,
    values,
    text: m.body.trim() || notice.text,
  });
  switch (notice.kind) {
    case "routine_handoff": {
      const routine = noticeRoutineName(notice);
      return routine ? line("chat.notice.routineHandoff", { routine }) : line("chat.notice.routineHandoffAnon");
    }
    case "consult_reply":
      return from ? line("chat.notice.consultReply", { from }) : line("chat.notice.consultReplyAnon");
    case "agent_note":
      return from ? line("chat.notice.agentNote", { from }) : line("chat.notice.agentNoteAnon");
    case "wait_result":
      return line("chat.notice.waitResult", { name: names.author });
    case "follow_up": {
      const followUp = followUpLine(notice, names.author, when);
      return followUp ? line(followUp.key, followUp.values) : null;
    }
    default:
      return line("chat.notice.other", { name: names.author });
  }
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

/** `meta.work`: how many tools the run used (its saved tool block shows only when it used some). */
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
      agentProposalOf(m.meta) ||
      m.meta?.missionStart ||
      m.meta?.threadStart ||
      m.meta?.issueWork ||
      m.meta?.browserHandoff ||
      m.meta?.missionSetup ||
      questionOf(m.meta)?.text.trim() === m.body.trim(),
  );

// ── Live work ────────────────────────────────────────────────────────────────

/**
 * Who shows in the working line, as on the web's bar (`barEntries`): agents
 * asking another agent, then agents at work, one entry per agent even when it
 * has two runs (a provisional "thinking" row and the real run, or two tasks at
 * once), then the people typing.
 */
export function workingEntries(
  runs: LiveRun[],
  consults: LiveConsult[],
  agentName: (id: string) => string,
  typing: string[] = [],
  personName: (id: string) => string | undefined = () => undefined,
): ActivityEntry[] {
  // Writing agents stay in: the line above the box is on while they work.
  return barEntries(runs, typing, agentName, personName, consults, true);
}

/**
 * Still working (thinking, queued, running a tool or writing): what "Parar" stops, right away, also while
 * the words arrive. A guessed "pensando…" has no run to stop yet.
 */
export const stoppableInLine = (runs: LiveRun[]) =>
  runs.filter((r) => !r.provisional && (r.status === "thinking" || r.status === "queued" || r.status === "running"));

/**
 * Who may press "Parar" (the web's `useStopRun`): admins, the agent's owner,
 * or the person whose message started the run. The server checks it again.
 */
export function mayStopRun(
  run: Pick<LiveRun, "agentId" | "threadId" | "triggerMessageId">,
  who: { meId: string | null; manageAgents: boolean; agentOwnerId: string | null | undefined; messages: Message[] },
): boolean {
  if (who.manageAgents) return true;
  if (!who.meId) return false;
  if (who.agentOwnerId === who.meId) return true;
  const rootId = run.triggerMessageId ?? run.threadId;
  const root = who.messages.find((m) => m.id === rootId);
  return root?.author.type === "person" && root.author.id === who.meId;
}

// Names travel through i18n wrapped in these, then come back bold (the web's WorkingLine does the same).
export const NAME_OPEN = "\u0001";
export const NAME_CLOSE = "\u0002";
export const markName = (name: string) => `${NAME_OPEN}${name}${NAME_CLOSE}`;

/** A marked sentence split into plain and bold (name) pieces. */
export function markedParts(text: string): { text: string; bold: boolean }[] {
  const [head = "", ...rest] = text.split(NAME_OPEN);
  const out: { text: string; bold: boolean }[] = head ? [{ text: head, bold: false }] : [];
  for (const part of rest) {
    const at = part.indexOf(NAME_CLOSE);
    const name = at < 0 ? part : part.slice(0, at);
    const after = at < 0 ? "" : part.slice(at + 1);
    if (name) out.push({ text: name, bold: true });
    if (after) out.push({ text: after, bold: false });
  }
  return out;
}

/** How wide the working line's pieces that can end in "…" drew their text (`onTextLayout`). */
export interface LineDrawn {
  agents?: number;
  typers?: number;
}

/** A piece only narrows: kept to what it drew, it can't draw wider, and a narrower room cuts it again. */
export const narrowDrawn = (drawn: LineDrawn, part: keyof LineDrawn, width: number): LineDrawn =>
  (drawn[part] ?? Number.POSITIVE_INFINITY) <= width ? drawn : { ...drawn, [part]: width };

/** Narrower than this, the agents' words cut short are a sliver ("A", "Th…"). */
export const AGENT_WORDS_MIN = 40;

/**
 * The widths the working line's pieces keep (whole points): iOS keeps a cut text's whole box, a gap before what
 * follows, so each keeps to what it drew and the next piece comes right after its "…". `agents: null` drops the
 * agents' words, their " · " with them, when beside someone typing they'd be a sliver: who types keeps the room,
 * as on the web.
 */
export function lineFit(drawn: LineDrawn, someoneTypes: boolean): { agents?: number | null; typers?: number } {
  const whole = (width?: number) => (width === undefined ? undefined : Math.ceil(width));
  const sliver = someoneTypes && drawn.agents !== undefined && drawn.agents < AGENT_WORDS_MIN;
  return { agents: sliver ? null : whole(drawn.agents), typers: whole(drawn.typers) };
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

export type Inline =
  | { kind: "text" | "bold" | "italic" | "code" | "mention"; text: string }
  | { kind: "link"; text: string; href: string };
export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; inline: Inline[] }
  | { kind: "bullet"; inline: Inline[]; ordinal: string | null }
  | { kind: "quote"; inline: Inline[] }
  | { kind: "code"; lang: string; text: string; open?: boolean }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][]; align: TableAlign[] };

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

/** Only these open from a message; anything else stays plain text. */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
/** A bare address ends before trailing punctuation, and before a ")" it did not open. */
function trimUrl(url: string) {
  let end = url.length;
  const count = (ch: string) => url.slice(0, end).split(ch).length - 1;
  while (end > 0) {
    const ch = url[end - 1] ?? "";
    if (/[.,;:!?'"]/.test(ch) || (ch === ")" && count("(") < count(")"))) end--;
    else break;
  }
  return url.slice(0, end);
}

/** Inline marks: `code`, [links](https://…) and bare https:// addresses, **bold**, *italic* / _italic_, @mentions. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re =
    /(`[^`\n]+`)|(!?\[([^\]]*)\]\(([^)\s]*)\))|(\bhttps?:\/\/[^\s<>`]+)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    let tok = m[0];
    if (m[5]) tok = trimUrl(tok);
    if (at > last) mentions(text.slice(last, at), out, "text");
    if (m[1]) out.push({ kind: "code", text: tok.slice(1, -1) });
    else if (m[2]) {
      // An image shows its words; a link to anything but the web or e-mail is just its words.
      const label = m[3] ?? "";
      const href = m[4] ?? "";
      if (!tok.startsWith("!") && SAFE_HREF.test(href)) out.push({ kind: "link", text: label || href, href });
      else mentions(label, out, "text");
    } else if (m[5]) out.push({ kind: "link", text: tok, href: tok });
    else if (m[6]) mentions(tok.slice(2, -2), out, "bold");
    else mentions(tok.slice(1, -1), out, "italic");
    last = at + tok.length;
  }
  if (last < text.length) mentions(text.slice(last), out, "text");
  return out.reduce<Inline[]>((acc, tok) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.kind === tok.kind && (tok.kind === "text" || tok.kind === "bold" || tok.kind === "italic"))
      prev.text += tok.text;
    else if (tok.text) acc.push({ ...tok });
    return acc;
  }, []);
}

/**
 * Blocks: fenced code (with its language), tables (the web's rule: `tableAt` from the shared parser, so a
 * table right under a sentence is still a table), headings, lists, quotes and paragraphs (lines of a
 * paragraph keep their breaks).
 */
export function parseBlocks(body: string): Block[] {
  const out: Block[] = [];
  const parts = body.split(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i += 3) {
    const text = parts[i] ?? "";
    // The last part may hold a block still being written (no closing fence yet): the web's rule, so an
    // answer that is still streaming shows its code (or "Montando o gráfico…") instead of the raw text.
    const last = i + 3 >= parts.length;
    const open = last ? /```([a-zA-Z0-9_+-]*)\n([\s\S]*)$/.exec(text) : null;
    if (open) {
      textBlocks(text.slice(0, open.index), out);
      const code = (open[2] ?? "").replace(/`{1,2}$/, "").replace(/\n$/, "");
      out.push({ kind: "code", lang: open[1] ?? "", text: code, open: true });
    } else textBlocks(last ? text.replace(/```[a-zA-Z0-9_+-]*$/, "") : text, out); // a fence still opening
    if (i + 2 < parts.length)
      out.push({ kind: "code", lang: parts[i + 1] ?? "", text: (parts[i + 2] ?? "").replace(/\n$/, "") });
  }
  return out;
}

function textBlocks(chunk: string, out: Block[]) {
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
    para = [];
  };
  const lines = chunk.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const table = tableAt(lines, n);
    if (table) {
      flush();
      const cells = (row: string[]) => row.map((c) => parseInline(c));
      out.push({
        kind: "table",
        header: cells(table.table.header),
        rows: table.table.rows.map(cells),
        align: table.table.align,
      });
      n = table.next - 1;
      continue;
    }
    const line = (lines[n] ?? "").trimEnd();
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
}
