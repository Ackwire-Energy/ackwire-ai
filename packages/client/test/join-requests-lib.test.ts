import { describe, expect, test } from "bun:test";
import type { AppNotification, JoinStatus } from "../src/api/types";
import { askView } from "../src/lib/join-requests";
import { openTarget } from "../src/lib/notifications";

const you = (patch: Partial<JoinStatus> = {}): JoinStatus => ({
  member: false,
  email: "ana@example.com",
  request: null,
  ...patch,
});

describe("askView: an invitation link's page", () => {
  test("signed out: the form, then sent (the answer comes by email)", () => {
    expect(askView({}, false)).toEqual({ state: "form" });
    expect(askView({}, true)).toEqual({ state: "sent" });
  });

  test("a closed link says only that, whatever else is known", () => {
    expect(askView({ closed: true, you: you({ member: true, orgId: "o1" }) }, true)).toEqual({ state: "closed" });
  });

  test("signed in: the server's answer wins over what the page knows", () => {
    expect(askView({ you: you() }, false)).toEqual({ state: "form" });
    expect(askView({ you: you({ request: { status: "pending", reason: null } }) }, false)).toEqual({ state: "sent" });
    expect(askView({ you: you({ request: { status: "approved", reason: null } }) }, true)).toEqual({
      state: "approvedEmail",
    });
    expect(askView({ you: you({ request: { status: "denied", reason: "Full team" } }) }, true)).toEqual({
      state: "denied",
      reason: "Full team",
    });
  });

  test("in: just approved, or a member before asking", () => {
    const approved = you({ member: true, orgId: "o1", request: { status: "approved", reason: null } });
    expect(askView({ you: approved }, true)).toEqual({ state: "in", orgId: "o1", already: false });
    expect(askView({ you: you({ member: true, orgId: "o1" }) }, false)).toEqual({
      state: "in",
      orgId: "o1",
      already: true,
    });
  });
});

test("a request to join opens Members", () => {
  const n = { kind: "join_request", source: { label: "Acme" }, actors: [] } as unknown as AppNotification;
  expect(openTarget(n)).toEqual({ to: "/org/$orgId/settings/$section", params: { section: "members" } });
});
