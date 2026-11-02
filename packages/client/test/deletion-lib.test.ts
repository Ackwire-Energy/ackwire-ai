import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AccountDeletionPlan } from "../src/api/types";
import { accountDeletionLines, deletionProof, proofToSend, soleOwnerWaysOut } from "../src/lib/deletion";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  key === "format.list"
    ? new Intl.ListFormat("en").format(o?.names as string[])
    : o && Object.keys(o).length > 0
      ? `${key} ${JSON.stringify(o)}`
      : key) as unknown as TFunction;

const plan = (patch: Partial<AccountDeletionPlan>): AccountDeletionPlan => ({
  closes: [],
  leaves: [],
  soleOwner: [],
  computers: [],
  staysBehind: [],
  serverOwner: false,
  ...patch,
});

describe("what deleting an account does, line by line", () => {
  const now = new Date("2026-10-30T12:00:00Z");

  test("workspaces only they are in close with it; one being deleted already keeps its own date", () => {
    const lines = accountDeletionLines(
      t,
      "en",
      plan({
        closes: [
          { id: "a", name: "Solo" },
          { id: "b", name: "Draft", deletion: { dueAt: "2026-11-02T12:00:00.000Z" } },
          { id: "c", name: "Late", deletion: { dueAt: null } },
        ],
      }),
      { cloud: true, now },
    );
    expect(lines.filter((l) => l.kind === "closes").map((l) => l.text)).toEqual([
      'deleteAccount.closes {"count":1,"names":"Solo","date":"Nov 6"}',
      'deleteAccount.closing {"name":"Draft","date":"Nov 2"}',
      'deleteAccount.closingLate {"name":"Late"}',
    ]);
  });

  test("what stays behind links to where each is disconnected: keys to Keys, the rest to Connectors", () => {
    const lines = accountDeletionLines(
      t,
      "en",
      plan({
        leaves: [{ id: "w", name: "Team", role: "member" }],
        staysBehind: [
          { orgId: "w", kind: "key", name: "Bia's key" },
          { orgId: "w", kind: "connection", name: "GitHub" },
          { orgId: "w", kind: "mailbox", name: "bia@team.com" },
        ],
      }),
      { cloud: true, now },
    );
    expect(lines.find((l) => l.kind === "staysBehind")).toEqual({
      kind: "staysBehind",
      text: 'deleteAccount.staysBehind {"name":"Team"}',
      links: [
        { label: `deleteAccount.disconnect {"name":"Bia's key"}`, orgId: "w", section: "keys" },
        { label: 'deleteAccount.disconnect {"name":"GitHub"}', orgId: "w", section: "connectors" },
        { label: 'deleteAccount.disconnect {"name":"bia@team.com"}', orgId: "w", section: "connectors" },
      ],
    });
  });

  test("where plans are billed, those they pay for stop renewing: said once, only with a workspace to have one", () => {
    const kinds = (patch: Partial<AccountDeletionPlan>, billing: boolean) =>
      accountDeletionLines(t, "en", plan(patch), { cloud: true, billing, now }).map((l) => l.kind);
    const leaves = { leaves: [{ id: "w", name: "Team", role: "member" as const }] };
    const closes = { closes: [{ id: "a", name: "Solo" }] };
    expect(kinds(leaves, true)).toEqual(["leaves", "plan", "messages"]);
    expect(kinds({ ...closes, ...leaves }, true)).toEqual(["closes", "leaves", "plan", "messages"]);
    expect(kinds({ ...closes, ...leaves }, false)).not.toContain("plan");
    expect(kinds({}, true)).toEqual(["messages"]);
  });
});

test("a workspace still being set up is finished or deleted in its onboarding, which has no People yet", () => {
  expect(soleOwnerWaysOut("w", false)).toEqual({
    people: "/org/w/settings/members",
    delete: "/org/w/settings/general?delete=1",
  });
  expect(soleOwnerWaysOut("w", true)).toEqual({ people: "/onboarding", delete: "/onboarding?delete=1" });
});

test("the proof: a code where the server sends email, else the password, which an account without one adds first", () => {
  expect(deletionProof({ passwordReset: true }, false)).toBe("code");
  // Until the server says, it's taken to send email, as invitations do.
  expect(deletionProof(undefined, true)).toBe("code");
  expect(deletionProof({ passwordReset: false }, true)).toBe("password");
  expect(deletionProof({ passwordReset: false }, undefined)).toBe("password");
  expect(deletionProof({ passwordReset: false }, false)).toBe("addPassword");
});

test("what the proof sends: all six digits once a code went out, or a typed password; nothing to add a password", () => {
  const typed = { sent: true, code: "48291", password: "" };
  expect(proofToSend("code", typed)).toEqual({ input: { code: "48291" }, ready: false });
  expect(proofToSend("code", { ...typed, code: "482913" })).toEqual({ input: { code: "482913" }, ready: true });
  expect(proofToSend("code", { ...typed, code: "482913", sent: false }).ready).toBe(false);
  expect(proofToSend("password", { ...typed, password: "pw" })).toEqual({ input: { password: "pw" }, ready: true });
  expect(proofToSend("password", typed).ready).toBe(false);
  expect(proofToSend("addPassword", { ...typed, password: "pw" })).toEqual({ input: {}, ready: false });
});
