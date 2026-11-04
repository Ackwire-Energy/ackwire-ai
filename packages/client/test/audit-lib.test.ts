import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AuditRow } from "../src/api/types";
import { auditOutcome, auditQueryOf, auditReason, auditSentence, auditSubLine } from "../src/lib/audit";

// The key and its values, so each test reads which words were picked.
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${key}(${Object.values(o).join(",")})` : key) as unknown as TFunction;

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: "a1",
  at: "2026-10-28T12:00:00Z",
  actor: { type: "agent", id: "ag", name: "Ada" },
  action: "tool.call",
  target: { type: "tool", id: "gmail_send" },
  details: { kind: "external", connector: "Gmail", title: "Gmail: Send", behind: "person", input: {} },
  runId: "r1",
  channelId: "c1",
  channel: { id: "c1", name: "geral", kind: "channel" },
  onBehalfOf: { id: "u1", name: "Bia" },
  outcome: "done",
  approval: null,
  secret: null,
  ...over,
});

const standing = (details: Record<string, unknown>) =>
  row({ actor: { type: "system", id: null, name: null }, action: "organization.standing_changed", details });

describe("Auditoria in words (web and phone)", () => {
  test("the shortcuts and the agent ask the server for the same thing on both", () => {
    expect(auditQueryOf("all", null)).toEqual({});
    // An agent: what it did and what people applied from its cards.
    expect(auditQueryOf("problems", "ag")).toEqual({ via: "ag", outcome: ["refused", "failed"] });
    expect(auditQueryOf("waiting", null)).toEqual({ waiting: true });
    // People's changes are people's, whichever agent was picked.
    expect(auditQueryOf("people", "ag")).toEqual({ actorType: "person", kind: "change" });
  });

  test("a billing hold's reason is said in words, never as its code; any other reason as written", () => {
    expect(auditReason(t, standing({ from: "active", to: "hold", reason: "unpaid" }))).toBe(
      "standing.notification.billing.unpaid",
    );
    expect(auditReason(t, standing({ from: "hold", to: "active", reason: null }))).toBeNull();
    expect(auditReason(t, standing({ from: "active", to: "hold", reason: "Spam reports" }))).toBe("Spam reports");
    expect(auditReason(t, row({ details: { reason: "unpaid" } }))).toBe("unpaid");
  });

  test("the category an automatic review hold names is said in words; plain review and an unknown one as written", () => {
    const hold = (reason: string) => auditReason(t, standing({ from: "active", to: "hold", reason }));
    expect(hold("review.phishing_impersonation")).toBe("standing.cloud.reviewWhat.phishing_impersonation");
    expect(hold("review.fraud")).toBe("standing.cloud.reviewWhat.fraud");
    expect(hold("review")).toBe("review");
    expect(hold("review.spam")).toBe("review.spam");
  });

  test("who did what, then about what, who asked and where", () => {
    expect(auditSentence(t, row(), "en")).toEqual({ name: "Ada", text: "audit.call.used(Gmail)" });
    expect(auditSubLine(t, row())).toBe("Gmail: Send · audit.behind.person(Bia) · #geral");
    const expired = row({ actor: { type: "system", id: null, name: null }, action: "approval.expired", details: {} });
    expect(auditSentence(t, expired, "en")).toEqual({ name: null, text: "audit.change.approval.expired" });
    const gone = row({ actor: { type: "person", id: "u1", name: "Bia" }, action: "channel.deleted", details: {} });
    expect(auditSentence(t, gone, "en").text).toBe(
      "audit.change.pattern(audit.change.verb.deleted,audit.change.area.channel)",
    );
  });

  test("a waiting call says what became of its approval or of the secret it asked for", () => {
    expect(auditOutcome(t, row())).toMatchObject({ mood: "done", text: "audit.outcome.done" });
    const waiting = row({ outcome: "pending", approval: { id: "ap", status: "pending", decidedBy: null } });
    expect(auditOutcome(t, waiting)).toMatchObject({ mood: "waiting", text: "audit.outcome.pending" });
    const refused = row({ outcome: "pending", approval: { id: "ap", status: "refused", decidedBy: null } });
    expect(auditOutcome(t, refused)).toMatchObject({ mood: "refused", text: "audit.outcome.refusedByPerson" });
    const asked = row({ outcome: "pending", secret: { id: "s", status: "pending" } });
    expect(auditOutcome(t, asked)).toMatchObject({ mood: "waiting", text: "audit.outcome.pendingSecret" });
    const delivered = row({ outcome: "pending", secret: { id: "s", status: "delivered" } });
    expect(auditOutcome(t, delivered)).toMatchObject({ mood: "neutral", text: "audit.outcome.delivered" });
    expect(auditOutcome(t, row({ action: "routine.created", outcome: null }))).toBeNull();
  });
});
