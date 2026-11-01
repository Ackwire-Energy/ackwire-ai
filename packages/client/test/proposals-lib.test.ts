import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Proposal } from "../src/api/types";
import {
  appLabel,
  cardHead,
  cardOutcome,
  cardProposalIds,
  changedLines,
  chosenRows,
  messageProposalCards,
  proposalSections,
  proposerOf,
  rowStatus,
  staleCount,
} from "../src/lib/proposals";

const t = ((key: string, o?: Record<string, unknown>) =>
  o && "defaultValue" in o
    ? `${key}=${o.defaultValue}`
    : o
      ? `${key} ${JSON.stringify(o)}`
      : key) as unknown as TFunction;

const row = (id: string, patch: Partial<Proposal> = {}): Proposal => ({
  id,
  agentId: `agent-${id}`,
  proposedByAgentId: "theo",
  target: { type: "agent_instructions", agentId: `agent-${id}` },
  title: "",
  why: "",
  evidence: [],
  before: "Seja breve.",
  after: "Seja breve.\n\n## Learned\n- Responder em português.",
  status: "pending",
  stale: false,
  canDecide: true,
  decider: { type: "admins" },
  createdAt: "2026-10-31T12:00:00.000Z",
  decidedBy: null,
  decidedAt: null,
  ...patch,
});
const role = (id: string, patch: Partial<Proposal> = {}) =>
  row(id, { target: { type: "agent_role", agentId: `agent-${id}` }, before: "Dev", after: "Revisora", ...patch });
const access = (id: string, patch: Partial<Proposal> = {}) =>
  row(id, {
    target: { type: "agent_access", agentId: `agent-${id}` },
    before: "",
    after: "",
    access: [{ id: "browser:use", label: "Use a browser", on: false }],
    ...patch,
  });

describe("a card of proposals", () => {
  test("its rows: every id, else the one an older server sent; its proposer, else the agent it changes", () => {
    expect(cardProposalIds({ proposalId: "a", proposalIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(cardProposalIds({ proposalId: "a" })).toEqual(["a"]);
    expect(cardProposalIds({ proposalIds: [] })).toEqual([]);
    expect(
      messageProposalCards({
        memoryUpdates: [
          { action: "remembered", itemId: "m", text: "x" },
          { action: "proposed", itemId: "a", text: "x", proposalId: "a", proposalIds: ["a", "b"] },
        ],
      }),
    ).toEqual([["a", "b"]]);
    expect(messageProposalCards({ proposalId: "old" })).toEqual([["old"]]);
    expect(messageProposalCards(null)).toEqual([]);
    expect(proposerOf(row("1"))).toBe("theo");
    expect(proposerOf(row("1", { proposedByAgentId: undefined }))).toBe("agent-1");
  });

  test("each change shows once: agents changed alike share it, roles and apps come after", () => {
    const swap = row("3", { before: "- Preços em $.", after: "- Preços em R$." });
    const sections = proposalSections([row("1"), access("4"), swap, role("5"), row("2")]);
    expect(sections.map((s) => [s.kind, s.rows.map((r) => r.id)])).toEqual([
      ["text", ["1", "2"]],
      ["text", ["3"]],
      ["role", ["5"]],
      ["access", ["4"]],
    ]);
    expect(changedLines(row("1"))).toEqual([
      { kind: "add", text: "## Learned" },
      { kind: "add", text: "- Responder em português." },
    ]);
    expect(changedLines(swap)).toEqual([
      { kind: "del", text: "- Preços em $." },
      { kind: "add", text: "- Preços em R$." },
    ]);
  });

  test("Aceitar acts on the open rows the viewer may decide and left on: 'todos' only when that is every open row", () => {
    const rows = [row("1"), row("2"), row("3", { canDecide: false }), row("4", { status: "accepted" })];
    expect(chosenRows(rows.slice(0, 2), new Set())).toMatchObject({ all: true });
    const some = chosenRows(rows, new Set(["2"]));
    expect(some.chosen.map((p) => p.id)).toEqual(["1"]);
    expect(some.all).toBe(false);
    // A row waiting for someone else keeps the count honest even with every switch on.
    expect(chosenRows(rows, new Set())).toMatchObject({ all: false });
    expect(chosenRows([row("1", { stale: true })], new Set()).chosen).toEqual([]);
  });

  test("a row says whom it waits for, or how it ended; only stale failures count as stale", () => {
    expect(rowStatus(t, row("1"))).toBeNull();
    expect(rowStatus(t, row("1", { canDecide: false }))).toBe("proposals.waitingAdmin");
    expect(rowStatus(t, row("1", { canDecide: false, decider: { type: "user", userId: "u", name: "Heitor" } }))).toBe(
      'proposals.waitingFor {"name":"Heitor"}',
    );
    expect(rowStatus(t, row("1", { stale: true }))).toBe("proposals.stale");
    expect(rowStatus(t, row("1", { status: "refused", canDecide: false }))).toBe("proposals.refused");
    expect(staleCount([{ error: { status: 409 } }, { error: { status: 403 } }, { error: null }])).toBe(1);
  });

  test("apps in the person's language: a built-in scope translated, a connection by its own name", () => {
    expect(appLabel(t, { id: "browser:use", label: "Use a browser", on: true })).toBe(
      "scopes.browser_use.label=Use a browser",
    );
    expect(appLabel(t, { id: "connector:c1", label: "Linear", on: true })).toBe("Linear");
  });

  test("the head: what one row changes, how many agents several change, or one agent's changes", () => {
    const name = (id: string) => (id === "agent-1" ? "Ada" : "Theo");
    expect(cardHead(t, [role("1")], "Theo", name, "Acme")).toEqual({
      key: "proposals.proposes",
      values: { agent: "Theo", target: expect.stringContaining("proposals.targetRole") },
    });
    expect(cardHead(t, [row("1"), row("2")], "Theo", name, "Acme")).toEqual({
      key: "proposals.proposesMany",
      values: { agent: "Theo", count: 2 },
    });
    expect(cardHead(t, [row("1"), role("2")], "Theo", name, "Acme").key).toBe("proposals.proposesManyChanges");
    const one = cardHead(t, [row("1"), role("1"), access("1")], "Theo", name, "Acme");
    expect(one.key).toBe("proposals.proposes");
    expect(String(one.values.target)).toContain('proposals.targetChanges {"name":"Ada"');
  });
});

describe("how a decided card ended", () => {
  const accepted = { status: "accepted" } as const;
  const refused = { status: "refused" } as const;

  test("rows that agree say their status", () => {
    expect(cardOutcome(t, [row("1", accepted), row("2", accepted)])).toEqual({
      accepted: true,
      label: "proposals.accepted",
    });
    expect(cardOutcome(t, [row("1", refused)])).toEqual({ accepted: false, label: "proposals.refused" });
    expect(cardOutcome(t, [row("1", { stale: true })])).toEqual({ accepted: false, label: "proposals.stale" });
  });

  test("rows that differ say how many were accepted", () => {
    expect(cardOutcome(t, [row("1", accepted), row("2", { stale: true })])).toEqual({
      accepted: true,
      label: 'proposals.acceptedSome {"done":1,"total":2}',
    });
  });
});
