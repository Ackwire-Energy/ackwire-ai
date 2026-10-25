import type {
  Agent,
  AgentAccess,
  AgentForYouItem,
  AgentUsage,
  Approval,
  DirectMessage,
  Memory,
  Mission,
  PreviewMeta,
  Role,
  WorkingRun,
} from "@agenteschat/client";
import { asksAt, levelOf, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { can } from "@agenteschat/client/lib/permissions";
import { daysAgo, previewOf } from "../shared/logic";

/**
 * Who is working now (runs in progress and active missions), the crew on
 * Início, and what an agent's profile shows about its month.
 */

const ACTIVE = new Set(["queued", "running", "waiting_approval", "waiting_input"]);

/** Something an agent is on right now. */
export interface WorkItem {
  key: string;
  agentId: string;
  kind: "run" | "mission";
  /** Mission: its title. Run: the thread's title or the start of its first message (null: say where instead). */
  what: string | null;
  channelId: string;
  /** Null: the main timeline (DMs are flat). */
  threadId: string | null;
  /** Where, for a run without a label: a channel's name, or a DM (no name). */
  where: { kind: "channel" | "dm"; name: string | null };
  missionId: string | null;
  plan: { done: number; total: number } | null;
  /** Since when (the mission's or the run's start, else when it was created). */
  since: string;
  /** A run stopped on a person (your ok, your answer): it isn't working, it waits ("espera seu ok"). */
  waiting: boolean;
}

/**
 * Active missions first (they are long work), then runs in progress (`GET
 * …/active-runs`, everyone's view of the conversations they are in), newest
 * first, one per agent and conversation. A routine's background runs are left out.
 */
export function workingNow(runs: WorkingRun[] | undefined, missions: Mission[] | undefined): WorkItem[] {
  const out: WorkItem[] = [];
  const seen = new Set<string>();
  const spot = (agentId: string, channelId: string, threadId: string | null) => `${agentId}:${threadId ?? channelId}`;
  for (const m of missions ?? []) {
    if (m.status !== "active") continue;
    out.push({
      key: `m:${m.id}`,
      agentId: m.agentId,
      kind: "mission",
      what: m.title,
      channelId: m.channelId,
      threadId: m.threadId,
      where: { kind: "channel", name: null },
      missionId: m.id,
      plan: { done: m.plan.done, total: m.plan.total },
      since: m.startedAt ?? m.createdAt,
      waiting: false,
    });
    seen.add(spot(m.agentId, m.channelId, m.threadId));
  }
  const newest = (r: WorkingRun) => r.startedAt ?? r.createdAt;
  for (const r of [...(runs ?? [])].sort((a, b) => newest(b).localeCompare(newest(a)))) {
    const at = spot(r.agentId, r.channelId, r.threadId);
    // A routine's background run holds no conversation: never "trabalhando" (its report comes as a notice).
    if (r.background || !ACTIVE.has(r.status) || seen.has(at)) continue;
    seen.add(at);
    out.push({
      key: `r:${r.runId}`,
      agentId: r.agentId,
      kind: "run",
      what: r.label?.trim() || null,
      channelId: r.channelId,
      threadId: r.threadId,
      where: { kind: r.channelKind, name: r.channelName },
      missionId: null,
      plan: null,
      since: newest(r),
      waiting: r.status === "waiting_approval" || r.status === "waiting_input",
    });
  }
  return out;
}

/** Agents with something in progress. */
export const busyAgents = (work: WorkItem[]) => new Set(work.map((w) => w.agentId));

/** Conversations where an agent is on something now (an agent DM shows "trabalhando…"). */
export const busyChannels = (work: WorkItem[]) => new Set(work.map((w) => w.channelId));

/** What each working agent is on: its first item (missions come first in `workingNow`). */
export function workByAgent(work: WorkItem[]): WorkItem[] {
  const seen = new Set<string>();
  return work.filter((w) => !seen.has(w.agentId) && Boolean(seen.add(w.agentId)));
}

/** One agent on Agentes: what waits on you, what it is on (working) or its last conversation (free). */
export interface TeamLine {
  agent: Agent;
  /** What it is on now; null when free. */
  work: WorkItem | null;
  /** Waiting on you: the request closest to expiring (the exact item), and how many there are. */
  approval: Pick<Approval, "id" | "title" | "createdAt"> | null;
  waitingCount: number;
  /** Waiting: since it asked. Working: since when. Free: its DM's last message. */
  at: string | null;
  /** Free: the last message of its DM (one line), else null. */
  preview: string | null;
  /** Free: that message's body was written by the server; show it in the reader's language (`previewBody`). */
  previewMeta?: PreviewMeta | null;
  /** Its brain's computer is offline and it waits for it ("Esperando o MacBook Air"): the computer's name. */
  computer?: string;
}

/**
 * Agentes: "Esperando você" (agents with a request you may decide, the one closest to
 * expiring first; `waiting` as `waitingApprovals` gives it), "Trabalhando agora" (in `workByAgent` order:
 * missions, then the newest runs) and "Livres" (the latest conversation first, then by name), each agent once.
 */
export function teamLines(
  agents: Agent[],
  work: WorkItem[],
  dms: Pick<DirectMessage, "with" | "lastMessage">[],
  waitingOnYou: Pick<Approval, "id" | "agentId" | "title" | "createdAt">[] = [],
  /** Agents waiting for an offline computer (`waitingComputerByAgent`): never "working", listed first in Livres. */
  offline: ReadonlyMap<string, { name: string }> = new Map(),
): { waiting: TeamLine[]; working: TeamLine[]; free: TeamLine[] } {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const waiting: TeamLine[] = [];
  const counts = new Map<string, number>();
  for (const a of waitingOnYou) counts.set(a.agentId, (counts.get(a.agentId) ?? 0) + 1);
  const firstWork = new Map(workByAgent(work).map((w) => [w.agentId, w]));
  for (const a of waitingOnYou) {
    const agent = byId.get(a.agentId);
    if (!agent || waiting.some((l) => l.agent.id === a.agentId)) continue;
    waiting.push({
      agent,
      work: firstWork.get(a.agentId) ?? null,
      approval: { id: a.id, title: a.title, createdAt: a.createdAt },
      waitingCount: counts.get(a.agentId) ?? 1,
      at: a.createdAt,
      preview: null,
    });
  }
  const asking = new Set(waiting.map((l) => l.agent.id));
  const working: TeamLine[] = [];
  for (const w of workByAgent(work)) {
    const agent = byId.get(w.agentId);
    if (agent && !asking.has(agent.id) && !offline.has(agent.id))
      working.push({ agent, work: w, approval: null, waitingCount: 0, at: w.since, preview: null });
  }
  const busy = new Set([...asking, ...working.map((l) => l.agent.id)]);
  const lastOf = new Map<string, NonNullable<DirectMessage["lastMessage"]>>();
  for (const d of dms) {
    if (d.with.type !== "agent" || !d.lastMessage) continue;
    const prev = lastOf.get(d.with.id);
    if (!prev || d.lastMessage.createdAt > prev.createdAt) lastOf.set(d.with.id, d.lastMessage);
  }
  const free = agents
    .filter((a) => !busy.has(a.id))
    .map((agent): TeamLine => {
      const last = lastOf.get(agent.id);
      return {
        agent,
        work: null,
        approval: null,
        waitingCount: 0,
        at: last?.createdAt ?? null,
        preview: last ? previewOf(last.body) || null : null,
        ...(last?.meta ? { previewMeta: last.meta } : {}),
        ...(offline.has(agent.id) ? { computer: offline.get(agent.id)?.name ?? "" } : {}),
      };
    })
    .sort((a, b) => {
      if (a.computer !== undefined || b.computer !== undefined) {
        if (a.computer === undefined) return 1;
        if (b.computer === undefined) return -1;
      }
      if (a.at && b.at) return b.at.localeCompare(a.at);
      if (a.at) return -1;
      if (b.at) return 1;
      return a.agent.name.localeCompare(b.agent.name);
    });
  return { waiting, working, free };
}

/** "há 4 min": how long ago, in the largest whole unit (under a minute: now). */
export type Ago = { unit: "now" } | { unit: "minutes" | "hours" | "days"; count: number };

export function agoOf(iso: string, now = Date.now()): Ago {
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min) || min < 1) return { unit: "now" };
  if (min < 60) return { unit: "minutes", count: min };
  const h = Math.floor(min / 60);
  if (h < 24) return { unit: "hours", count: h };
  return { unit: "days", count: Math.floor(h / 24) };
}

/**
 * "Este mês": money only when the API gives it to this person (ADR 0026: members
 * see a percentage), else the share of the budget used.
 */
export type Spend =
  | { kind: "money"; spentUsd: number; budgetUsd: number; fraction: number }
  | { kind: "percent"; percent: number; fraction: number };

export function spendOf(input: {
  budgetUsedPercent: number;
  monthlyBudgetUsd?: number | null;
  defaultBudgetUsd?: number;
  usage?: AgentUsage | null;
}): Spend {
  const budget = input.monthlyBudgetUsd ?? input.defaultBudgetUsd ?? null;
  const fraction = Math.min(1, Math.max(0, input.budgetUsedPercent / 100));
  if (input.usage && budget != null && budget > 0)
    return {
      kind: "money",
      spentUsd: input.usage.costUsd,
      budgetUsd: budget,
      fraction: Math.min(1, Math.max(0, input.usage.costUsd / budget)),
    };
  return { kind: "percent", percent: Math.round(Math.max(0, input.budgetUsedPercent)), fraction };
}

/** "Pode usar": the apps it may use (granted or inherited), then the built-in groups, by label. */
export function canUse(access: AgentAccess | null | undefined): { key: string; label: string; app: boolean }[] {
  if (!access) return [];
  const on = (s: string) => s === "granted" || s === "inherited";
  const apps = access.connectors
    .filter((c) => access.all || on(c.state) || c.scopes.some((s) => on(s.state)))
    .map((c) => ({ key: `c:${c.connectionId}`, label: c.label, app: true }));
  const builtins = access.builtins
    .filter((s) => access.all || on(s.state) || s.tools.some((x) => on(x.state)))
    .map((s) => ({ key: `b:${s.scope}`, label: s.label, app: false }));
  return [...apps, ...builtins];
}

/* ---------- The profile as a teammate ("Perfil do agente") ---------- */

/** Openings of a system prompt that name the agent ("Você é o Theo, …", "You are Theo, …"). */
const SELF_INTRO = /^(voc[eê] [eé]|you are|tu [eé]s)(?=[\s,]|$)/i;
/** Longest role line the profile shows. */
const PLAIN_MAX = 90;

/**
 * Its role in one plain sentence, from what someone wrote it should do: the first sentence that isn't the
 * prompt's self-introduction ("Você é o Theo, desenvolvedor…" keeps what follows the comma), short, without
 * markdown, starting in upper case. Null when nothing plain is left (the profile then shows only the role).
 */
export function plainRole(instructions: string | null | undefined): string | null {
  const sentences = (instructions ?? "")
    .split(/\n+/)
    .flatMap((l) => l.split(/[.!?;]\s+/))
    .map((l) => previewOf(l).replace(/[.!?;:]+$/, ""));
  for (const sentence of sentences) {
    let line = sentence;
    // "Você é o Theo, desenvolvedor do Time" → "desenvolvedor do Time"; "Você é o Theo" alone → the next one.
    if (SELF_INTRO.test(line)) {
      const comma = line.indexOf(",");
      line = comma >= 0 ? line.slice(comma + 1).trim() : "";
    }
    if (line.length < 3) continue;
    if (line.length > PLAIN_MAX) {
      const cut = line.slice(0, PLAIN_MAX);
      line = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,;:]$/, "")}…`;
    }
    return line.charAt(0).toUpperCase() + line.slice(1);
  }
  return null;
}

/** Only the agent's owner or an admin may correct or forget its memories (the server checks it again). */
export function canEditMemories(
  agent: Pick<Agent, "ownerUserId"> | undefined,
  viewer: { id: string | null; role: Role | null | undefined },
): boolean {
  if (!viewer.id) return false;
  if (can(viewer.role ?? undefined, "configure")) return true;
  return Boolean(agent?.ownerUserId && agent.ownerUserId === viewer.id);
}

/** Where a memory came from, said from the viewer's side. */
export type MemoryOrigin =
  | { kind: "saidDm"; at: string }
  | { kind: "saidChannel"; channel: string | null; at: string }
  | { kind: "wrote"; at: string }
  | { kind: "learned"; at: string };

export function memoryOrigin(m: Pick<Memory, "from" | "origin" | "editedByUserId" | "updatedAt">, meId: string | null) {
  if (m.from)
    return m.from.dm
      ? ({ kind: "saidDm", at: m.from.at } as const)
      : ({ kind: "saidChannel", channel: m.origin?.channel ?? null, at: m.from.at } as const);
  if (m.origin?.by === "person" && meId && m.editedByUserId === meId)
    return { kind: "wrote", at: m.origin.at } as const;
  return { kind: "learned", at: m.origin?.at ?? m.updatedAt } as const;
}

/** "O que sabe sobre você": the active ones, pinned first, then the newest. */
export function knownAboutMe(list: Memory[] | undefined): Memory[] {
  return (list ?? [])
    .filter((m) => !m.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

/** "hoje", "ontem" or the date, for "Você disse hoje". */
export type DayWord = { kind: "today" | "yesterday" } | { kind: "date"; iso: string };
export function dayWord(iso: string, now = new Date()): DayWord {
  const d = daysAgo(iso, now);
  if (d <= 0) return { kind: "today" };
  if (d === 1) return { kind: "yesterday" };
  return { kind: "date", iso };
}

/** One line of "O que fez por você": what to say (an i18n key under `mobile.intentAgents.did` + values), the icon, where it opens. */
export interface DidLine {
  key: string;
  icon: "issue" | "doc" | "code" | "shield" | "check" | "x" | "pen" | "chat" | "clock" | "hash";
  /** i18n key (relative to `mobile.intentAgents.did`) and its values for line 1. */
  title: { key: string; values: Record<string, string> };
  /** Line 2: a literal (a title) or an i18n key (relative to `mobile.intentAgents.did`). */
  sub: { text: string } | { key: string; values?: Record<string, string> } | null;
  href:
    | { kind: "issue"; number: number }
    | { kind: "chat"; channelId: string; threadId: string | null }
    | { kind: "file"; id: string }
    | { kind: "approval"; id: string }
    | null;
  at: string;
  /** Waits on the viewer now ("espera seu ok"). */
  waiting: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

const FILE_KIND: Record<string, string> = {
  document: "document",
  table: "table",
  diff: "diff",
  html: "document",
  diagram: "image",
  file: "file",
};

/** "O que fez por você", in the profile's words (third person: "Abriu a issue #131"). */
export function didLines(items: AgentForYouItem[] | undefined): DidLine[] {
  return (items ?? []).flatMap((i): DidLine[] => {
    if (i.type === "file")
      return [
        {
          key: `f:${i.file.id}`,
          icon: i.file.kind === "diff" ? "code" : "doc",
          title: { key: "file", values: { title: i.file.title } },
          sub: { key: `fileKind.${FILE_KIND[i.file.kind] ?? "file"}` },
          href: { kind: "file", id: i.file.id },
          at: i.at,
          waiting: false,
        },
      ];
    if (i.type === "approval") {
      const a = i.approval;
      const sub = a.waitingOnYou
        ? "waitingOnYou"
        : a.status === "approved"
          ? "youApproved"
          : a.status === "refused"
            ? "youRefused"
            : null;
      return [
        {
          key: `a:${a.id}`,
          icon: a.waitingOnYou ? "shield" : a.status === "refused" ? "x" : "check",
          title: { key: "approval", values: { title: a.title } },
          sub: sub ? { key: sub } : null,
          href: { kind: "approval", id: a.id },
          at: i.at,
          waiting: a.waitingOnYou,
        },
      ];
    }
    const { action: x } = i;
    const t = x.target;
    const p = x.params;
    const title = str(p.title) || t.title || "";
    const chat = { kind: "chat" as const, channelId: i.channelId, threadId: null };
    const line = (
      key: string,
      icon: DidLine["icon"],
      values: Record<string, string>,
      sub: DidLine["sub"],
      href: DidLine["href"],
    ): DidLine[] => [
      { key: `x:${x.id}`, icon, title: { key: `action.${key}`, values }, sub, href, at: i.at, waiting: false },
    ];
    const issue = { number: str(p.number) || str(t.number) };
    const issueHref = typeof t.number === "number" ? { kind: "issue" as const, number: t.number } : chat;
    switch (x.kind) {
      case "issue.created":
        return line("issueCreated", "issue", issue, title ? { text: title } : null, issueHref);
      case "issue.updated":
        return line("issueUpdated", "issue", issue, title ? { text: title } : null, issueHref);
      case "issue.assigned":
        return line("issueAssigned", "issue", issue, title ? { text: title } : null, issueHref);
      case "routine.created":
        return line("routineCreated", "clock", { name: str(p.name) || title }, null, chat);
      case "routine.updated":
        return line("routineUpdated", "clock", { name: str(p.name) || title }, null, chat);
      case "channel.agent_added":
        return line(
          "agentAdded",
          "hash",
          { name: str(p.agentName), channel: t.title ?? "" },
          null,
          t.id ? { kind: "chat", channelId: t.id, threadId: null } : chat,
        );
      case "wiki.page_created":
        return line("pageCreated", "doc", { title }, null, chat);
      case "wiki.page_edited":
        return line("pageEdited", "pen", { title }, null, chat);
      case "thread.renamed":
        return line("threadRenamed", "chat", { to: str(p.to) }, null, {
          kind: "chat",
          channelId: i.channelId,
          threadId: t.id,
        });
      case "thread.closed":
        return line("threadClosed", "chat", { title }, null, { kind: "chat", channelId: i.channelId, threadId: t.id });
      default:
        // Memory receipts are in "O que sabe sobre você"; kinds this app doesn't know yet stay out.
        return [];
    }
  });
}

/** "O que pode usar": each app or built-in area with a level, in plain words; whether any action still asks. */
export interface UseLine {
  key: string;
  /** An app's own name (GitHub), or a built-in area to say in the app's words (drive, issues…). */
  label: { text: string } | { area: string };
  level: "read" | "write" | "some";
}

export function usesOf(access: AgentAccess | null | undefined): { lines: UseLine[]; asks: boolean } {
  if (!access) return { lines: [], asks: false };
  const lines: UseLine[] = [];
  let asks = false;
  for (const r of resourcesOf(access)) {
    const level = levelOf(r);
    if (level === "none") continue;
    if (asksAt(r, level).length > 0) asks = true;
    lines.push({
      key: r.id,
      label: r.kind === "connector" || !r.area ? { text: r.label } : { area: r.area },
      level: level === "custom" ? "some" : level,
    });
  }
  return { lines, asks };
}
