import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AccountDeletionPlan } from "../src/api/types";
import { accountDeletionLines, soleOwnerWaysOut } from "../src/lib/deletion";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

const plan = (patch: Partial<AccountDeletionPlan>): AccountDeletionPlan => ({
  password: true,
  freshUntil: null,
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
        leaves: [{ id: "w", name: "Team", role: "admin" }],
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
});

test("a workspace still being set up is finished or deleted in its onboarding, which has no People yet", () => {
  expect(soleOwnerWaysOut("w", false)).toEqual({
    people: "/org/w/settings/members",
    delete: "/org/w/settings/general?delete=1",
  });
  expect(soleOwnerWaysOut("w", true)).toEqual({ people: "/onboarding", delete: "/onboarding?delete=1" });
});
