import type { AgentAppearance } from "@agenteschat/ui";
import type { AgentAudience, BrainKind, Run } from "@/api/types";
import type { Level, LevelState } from "./access-levels";
import { readBudget } from "./new-agent";
import { type RepoChoice, sameRepoChoice } from "./repos";

/*
 * The agent page (docs/design/telas/AgentePerfil.html): one draft over
 * everything that can be edited, one save bar. What the server says is
 * `Saved`; what the person changed is `Edits` (only the touched fields), so
 * parts that load later (access, skills, the computer) never reset a draft.
 */

export const AGENT_TABS = ["overview", "instructions", "access", "memory", "activity", "settings"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];
export const isAgentTab = (v: unknown): v is AgentTab => AGENT_TABS.includes(v as AgentTab);

/** Configurações' sections, in order. */
export const AGENT_SECTIONS = [
  "identity",
  "model",
  "brain",
  "budget",
  "owner",
  "audience",
  "channels",
  "computer",
  "danger",
] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];
export const isAgentSection = (v: unknown): v is AgentSection => AGENT_SECTIONS.includes(v as AgentSection);

/** `?tab=access&sec=model` (unknown values are dropped). */
export function agentSearch(search: Record<string, unknown>): { tab?: AgentTab; sec?: AgentSection } {
  return {
    tab: isAgentTab(search.tab) ? search.tab : undefined,
    sec: isAgentSection(search.sec) ? search.sec : undefined,
  };
}

export type Look = Required<AgentAppearance>;

/** "Quem pensa": the brain, its model (null = the brain's default) and the fallback to the API. */
export interface BrainChoice {
  brain: BrainKind;
  model: string | null;
  fallback: boolean;
  /** The person confirmed the plan warning for this brain in this edit (never sent; gates `acceptPlanTerms`). */
  termsAccepted?: boolean;
}
export const sameBrain = (a: BrainChoice, b: BrainChoice) =>
  a.brain === b.brain && (a.brain === "model" || a.model === b.model) && a.fallback === b.fallback;
/** Choosing Claude Code or Codex anew needs the warning confirmed (the plan is personal). */
export const needsPlanWarning = (saved: BrainKind | undefined, next: BrainKind) => next !== "model" && next !== saved;
/** Saving a switch to Claude Code or Codex the person hasn't confirmed yet: the warning blocks the save first. */
export const termsPending = (saved: BrainKind | undefined, next: BrainChoice | undefined) =>
  Boolean(next && needsPlanWarning(saved, next.brain) && next.termsAccepted !== true);

/** What can be edited, as the server has it now. Parts not loaded yet are absent. */
export interface Saved {
  name: string;
  role: string;
  look: Look;
  instructions: string;
  model: string;
  /** `DEFAULT_KEY` or a credential id (admins only). */
  key?: string;
  /** Its own budget (US$); null = the workspace default (admins only). */
  budget?: number | null;
  /** A user id or `NO_OWNER`. */
  owner: string;
  audience: AgentAudience;
  /** Resource id → level (from the access tree). */
  levels?: Record<string, LevelState>;
  /** Its GitHub repositories (all, or some in order). */
  repos?: RepoChoice;
  /** Enabled skill ids, sorted. */
  skills?: string[];
  /** Channels it is in that the viewer can pick (no DMs), sorted. */
  channels?: string[];
  /** `"cloud"` or a machine id. */
  machine?: string;
  /** Who thinks (owner and admins only; absent until loaded). */
  brain?: BrainChoice;
}

/** What the person changed. `budget` is the text typed; `levels` only the resources touched. */
export interface Edits {
  name?: string;
  role?: string;
  look?: Look;
  instructions?: string;
  model?: string;
  key?: string;
  budget?: string;
  owner?: string;
  audience?: AgentAudience;
  levels?: Record<string, Level>;
  repos?: RepoChoice;
  skills?: string[];
  channels?: string[];
  machine?: string;
  brain?: BrainChoice;
}

export type Field = Exclude<keyof Edits, "levels"> | "levels";

/** Who edits what (the server's rules): admins everything; the agent's owner its look, access, audience, computer and who thinks. */
export type Viewer = "admin" | "owner" | "member";
export const OWNER_EDITS: ReadonlySet<Field> = new Set<Field>([
  "look",
  "levels",
  "repos",
  "audience",
  "machine",
  "brain",
]);
export const canEdit = (viewer: Viewer, field: Field) =>
  viewer === "admin" || (viewer === "owner" && OWNER_EDITS.has(field));

/** Where each field lives: its tab, and its section in Configurações. */
export const FIELD_PLACE: Record<Field, { tab: AgentTab; sec?: AgentSection }> = {
  name: { tab: "settings", sec: "identity" },
  role: { tab: "settings", sec: "identity" },
  look: { tab: "settings", sec: "identity" },
  instructions: { tab: "instructions" },
  levels: { tab: "access" },
  repos: { tab: "access" },
  skills: { tab: "access" },
  model: { tab: "settings", sec: "model" },
  key: { tab: "settings", sec: "model" },
  budget: { tab: "settings", sec: "budget" },
  owner: { tab: "settings", sec: "owner" },
  audience: { tab: "settings", sec: "audience" },
  channels: { tab: "settings", sec: "channels" },
  machine: { tab: "settings", sec: "computer" },
  brain: { tab: "settings", sec: "brain" },
};

const sorted = (list: string[]) => [...list].sort();
const sameList = (a: string[], b: string[]) => sorted(a).join("\n") === sorted(b).join("\n");
export const sameLook = (a: Look, b: Look) => a.color === b.color && a.eyes === b.eyes && a.accessory === b.accessory;
export const sameAudience = (a: AgentAudience, b: AgentAudience) =>
  a.mode === b.mode && (a.mode !== "people" || sameList(a.userIds, b.userIds));

/** The budget typed, as the API takes it (null = the default); undefined when it isn't a valid amount. */
export const budgetValue = (text: string): number | null | undefined => {
  const b = readBudget(text);
  return b.invalid ? undefined : b.amount;
};

/** One changed thing: a field, or one resource's level (`levels:{resourceId}`). */
export interface ChangeKey {
  key: string;
  field: Field;
  /** For levels: the resource id. */
  resource?: string;
}

/** The keys that differ from what is saved. */
export function changedKeys(saved: Saved, edits: Edits): ChangeKey[] {
  const out: ChangeKey[] = [];
  const add = (field: Field) => out.push({ key: field, field });
  if (edits.name !== undefined && edits.name !== saved.name) add("name");
  if (edits.role !== undefined && edits.role !== saved.role) add("role");
  if (edits.look && !sameLook(edits.look, saved.look)) add("look");
  if (edits.instructions !== undefined && edits.instructions !== saved.instructions) add("instructions");
  if (edits.levels && saved.levels) {
    for (const [id, level] of Object.entries(edits.levels)) {
      if (saved.levels[id] !== undefined && saved.levels[id] !== level)
        out.push({ key: `levels:${id}`, field: "levels", resource: id });
    }
  }
  if (edits.repos && saved.repos && !sameRepoChoice(edits.repos, saved.repos)) add("repos");
  if (edits.skills && saved.skills && !sameList(edits.skills, saved.skills)) add("skills");
  if (edits.model !== undefined && edits.model !== saved.model) add("model");
  if (edits.key !== undefined && saved.key !== undefined && edits.key !== saved.key) add("key");
  if (edits.budget !== undefined && saved.budget !== undefined && budgetValue(edits.budget) !== saved.budget)
    add("budget");
  if (edits.owner !== undefined && edits.owner !== saved.owner) add("owner");
  if (edits.audience && !sameAudience(edits.audience, saved.audience)) add("audience");
  if (edits.channels && saved.channels && !sameList(edits.channels, saved.channels)) add("channels");
  if (edits.machine !== undefined && saved.machine !== undefined && edits.machine !== saved.machine) add("machine");
  if (edits.brain && saved.brain && !sameBrain(edits.brain, saved.brain)) add("brain");
  return out;
}

/** Edits without one change (Desfazer). */
export function revertKey(edits: Edits, key: string): Edits {
  const next = { ...edits };
  if (key.startsWith("levels:")) {
    const id = key.slice("levels:".length);
    const levels = { ...(next.levels ?? {}) };
    delete levels[id];
    next.levels = levels;
    return next;
  }
  delete next[key as keyof Edits];
  return next;
}

/** Edits without the ones that went through (a field, or every level). */
export function dropFields(edits: Edits, fields: Field[]): Edits {
  const next = { ...edits };
  for (const f of fields) delete next[f];
  return next;
}

/** Lines added and removed between two texts (the instructions' "2 linhas novas, 1 removida"). */
export function lineChanges(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // Longest common subsequence of lines, in one flat table.
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const same = at(0, 0);
  return { added: m - same, removed: n - same };
}

/** The new channel list (PUT replaces it): keeps DMs, private channels and auto-reply; adds and removes. */
export function channelsAfter(
  current: { id: string; autoReply: boolean }[],
  saved: string[],
  wanted: string[],
): { channelId: string; autoReply?: boolean }[] {
  const removed = new Set(saved.filter((id) => !wanted.includes(id)));
  const kept = current.filter((c) => !removed.has(c.id)).map((c) => ({ channelId: c.id, autoReply: c.autoReply }));
  const have = new Set(kept.map((c) => c.channelId));
  return [...kept, ...wanted.filter((id) => !have.has(id)).map((channelId) => ({ channelId }))];
}

/* ---------- Atividade ---------- */

export type RunFilter = "all" | "failed" | "waiting" | "routines";

/**
 * A run started by one of the agent's routines: the routine posts its prompt
 * (after `@handle` in a channel), so the run's text starts with it.
 */
export function isRoutineRun(run: Pick<Run, "what">, prompts: string[], handle: string) {
  const text = run.what.trim().replace(new RegExp(`^@${handle}\\s+`, "i"), "");
  return prompts.some((p) => {
    const head = p.trim().slice(0, 80);
    return head.length > 0 && text.startsWith(head);
  });
}

export function runMatches(
  run: Run,
  filter: RunFilter,
  query: string,
  extra: { where: string; routine: boolean },
): boolean {
  if (filter === "failed" && run.status !== "failed") return false;
  if (filter === "waiting" && run.status !== "waiting_approval" && run.status !== "waiting_input") return false;
  if (filter === "routines" && !extra.routine) return false;
  const q = query.trim().toLowerCase();
  return !q || `${run.what} ${extra.where}`.toLowerCase().includes(q);
}

/** Runs grouped by calendar day (newest first, as the API sends them). */
export function groupByDay<T extends { createdAt: string }>(runs: T[]): { day: string; runs: T[] }[] {
  const out: { day: string; runs: T[] }[] = [];
  for (const r of runs) {
    const d = new Date(r.createdAt);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = out[out.length - 1];
    if (last && last.day === day) last.runs.push(r);
    else out.push({ day, runs: [r] });
  }
  return out;
}

/** Runs since the first day of this month (local time). */
export const thisMonth = (iso: string, now = new Date()) => {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
};
