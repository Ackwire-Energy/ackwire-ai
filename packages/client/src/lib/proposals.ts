import type { TFunction } from "i18next";
import type { MemoryUpdate, Proposal, ProposalAccessLine } from "../api/types";
import { agentGrammar } from "./grammar";
import { scopeText } from "./scopes";

/*
 * A card of proposed changes in the chat (`memory.updated`, `proposed`, ADR 0092): an agent asked to change its own
 * or its teammates' instructions, roles or apps, or the org context. One proposal per agent and kind of change, each
 * decided by whoever may make that change on the agent's page; the apps lay these rules out.
 */

/** The proposals on a card: every row, or the one an older server named (`proposalId`). */
export const cardProposalIds = (u: Pick<MemoryUpdate, "proposalId" | "proposalIds">): string[] =>
  u.proposalIds?.length ? u.proposalIds : u.proposalId ? [u.proposalId] : [];

/** The proposal cards a message carries: one per proposal in `meta.memoryUpdates`, else its older `meta.proposalId`. */
export function messageProposalCards(meta: Record<string, unknown> | null | undefined): string[][] {
  const updates = Array.isArray(meta?.memoryUpdates) ? (meta.memoryUpdates as Partial<MemoryUpdate>[]) : [];
  const cards = updates.flatMap((u) => (u?.action === "proposed" ? [cardProposalIds(u)] : [])).filter((c) => c.length);
  return cards.length || typeof meta?.proposalId !== "string" ? cards : [[meta.proposalId]];
}

/** The agent that proposed it (older servers: the agent it changes). */
export const proposerOf = (p: Pick<Proposal, "agentId" | "proposedByAgentId">) => p.proposedByAgentId || p.agentId;

/** Still waiting for a decision. */
export const isOpen = (p: Pick<Proposal, "status" | "stale">) => p.status === "pending" && !p.stale;

export interface ChangedLine {
  kind: "add" | "del";
  text: string;
}

/** What a text proposal changes: the lines it takes out, then the ones it puts in (blank ones aside). */
export function changedLines(p: Pick<Proposal, "before" | "after">): ChangedLine[] {
  const before = p.before.split("\n");
  const after = p.after.split("\n");
  const only = (lines: string[], other: string[]) => {
    const seen = new Set(other);
    return lines.filter((l) => l.trim() && !seen.has(l));
  };
  return [
    ...only(before, after).map((text) => ({ kind: "del" as const, text })),
    ...only(after, before).map((text) => ({ kind: "add" as const, text })),
  ];
}

/**
 * The line that says what a text proposal changes, for a card's short form: the first it adds, past any heading,
 * without its list mark.
 */
export function firstChange(lines: ChangedLine[] | undefined): ChangedLine | undefined {
  const added = (lines ?? []).filter((l) => l.kind === "add");
  const line = added.find((l) => !l.text.trim().startsWith("#")) ?? added[0] ?? lines?.[0];
  return line && { ...line, text: line.text.replace(/^\s*[-*+]\s+/, "") };
}

export type ProposalSection =
  | { kind: "text"; lines: ChangedLine[]; rows: Proposal[] }
  | { kind: "role" | "access"; rows: Proposal[] };

/**
 * A card's rows by what they change, so each change shows once: text rows (instructions, the org context) that
 * change the same lines together under those lines, then the new roles, then the apps.
 */
export function proposalSections(rows: Proposal[]): ProposalSection[] {
  const text = new Map<string, { kind: "text"; lines: ChangedLine[]; rows: Proposal[] }>();
  const role: Proposal[] = [];
  const access: Proposal[] = [];
  for (const p of rows) {
    if (p.target.type === "agent_role") role.push(p);
    else if (p.target.type === "agent_access") access.push(p);
    else {
      const lines = changedLines(p);
      const key = JSON.stringify(lines);
      const section = text.get(key) ?? { kind: "text", lines, rows: [] };
      section.rows.push(p);
      text.set(key, section);
    }
  }
  return [
    ...text.values(),
    ...(role.length ? [{ kind: "role" as const, rows: role }] : []),
    ...(access.length ? [{ kind: "access" as const, rows: access }] : []),
  ];
}

/**
 * What the card's Aceitar and Recusar act on: the open rows the viewer may decide and left switched on. `all`
 * while that is every open row on the card ("Aceitar para todos"), else the button counts them ("Aceitar para 2").
 */
export function chosenRows(rows: Proposal[], off: ReadonlySet<string>) {
  const open = rows.filter(isOpen);
  const chosen = open.filter((p) => p.canDecide && !off.has(p.id));
  return { chosen, all: chosen.length === open.length };
}

/** A row's state in words: decided, stale, or whom it waits for; null while the viewer may decide it. */
export function rowStatus(t: TFunction, p: Proposal): string | null {
  if (p.stale) return t("proposals.stale");
  if (p.status === "accepted") return t("proposals.accepted");
  if (p.status === "refused") return t("proposals.refused");
  if (p.canDecide) return null;
  return p.decider.type === "user" ? t("proposals.waitingFor", { name: p.decider.name }) : t("proposals.waitingAdmin");
}

/** How a decided card ended, in a word: each row's status when they all agree, else how many were accepted. */
export function cardOutcome(t: TFunction, rows: Proposal[]): { accepted: boolean; label: string } {
  const done = rows.filter((p) => p.status === "accepted" && !p.stale).length;
  const states = [...new Set(rows.map((p) => rowStatus(t, p)))];
  const label =
    states.length === 1 && states[0] ? states[0] : t("proposals.acceptedSome", { done, total: rows.length });
  return { accepted: done > 0, label };
}

/** Rows a decision couldn't apply because what they were made against changed since (409). */
export const staleCount = (failed: { error: unknown }[]) =>
  failed.filter((f) => (f.error as { status?: unknown } | null)?.status === 409).length;

/** An app on an access row in the person's language: a built-in scope translated, a connection by its name. */
export const appLabel = (t: TFunction, line: ProposalAccessLine) =>
  line.id.startsWith("connector:")
    ? line.label
    : scopeText(t, { id: line.id, label: line.label, description: "", sensitive: false }).label;

/** What one proposal changes, after "propõe ·": "instruções da Ada", "papel do Theo", "contexto da Acme". */
export function proposalTarget(t: TFunction, p: Proposal, agentName: (id: string) => string, orgName: string) {
  if (p.target.type === "org_context") return t("proposals.targetContext", { org: orgName });
  const g = agentGrammar(agentName(p.target.agentId));
  if (p.target.type === "agent_role") return t("proposals.targetRole", g);
  if (p.target.type === "agent_access") return t("proposals.targetAccess", g);
  if (p.target.type === "skill") return t("proposals.targetSkill", { skill: p.target.name });
  return t("proposals.targetInstructions", g);
}

/**
 * The card's head as a key and its values (`<b>` marks the proposer): one row says what it changes; several say how
 * many agents ("instruções de 3 agentes", "mudanças em 2 agentes"), or "mudanças para a Ada" when they are one's.
 */
export function cardHead(
  t: TFunction,
  rows: Proposal[],
  proposer: string,
  agentName: (id: string) => string,
  orgName: string,
): {
  key: "proposals.proposes" | "proposals.proposesMany" | "proposals.proposesManyChanges";
  values: Record<string, string | number>;
} {
  const agents = [...new Set(rows.flatMap((p) => (p.target.type === "org_context" ? [] : [p.target.agentId])))];
  const [first] = rows;
  if (rows.length === 1 && first)
    return {
      key: "proposals.proposes",
      values: { agent: proposer, target: proposalTarget(t, first, agentName, orgName) },
    };
  if (agents.length > 1) {
    const key = rows.every((p) => p.target.type === "agent_instructions")
      ? "proposals.proposesMany"
      : "proposals.proposesManyChanges";
    return { key, values: { agent: proposer, count: agents.length } };
  }
  const target = t("proposals.targetChanges", agentGrammar(agentName(agents[0] ?? "")));
  return { key: "proposals.proposes", values: { agent: proposer, target } };
}

const TITLE_KEY = {
  agent_instructions: "proposals.titleInstructions",
  agent_role: "proposals.titleRole",
  agent_access: "proposals.titleAccess",
  skill: "proposals.titleSkill",
} as const;

/** Its title in the person's language (the server's is English). */
export function proposalTitle(t: TFunction, p: Proposal, orgName: string, agentName: (id: string) => string) {
  const tt = t as unknown as (key: string, options: Record<string, string | undefined>) => string;
  if (p.target.type === "org_context") return tt("proposals.titleContext", { org: orgName, defaultValue: p.title });
  return tt(TITLE_KEY[p.target.type], {
    ...agentGrammar(agentName(p.target.agentId)),
    skill: p.target.type === "skill" ? p.target.name : "",
    defaultValue: p.title,
  });
}
