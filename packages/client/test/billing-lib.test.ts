import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import type { AppNotification } from "../src/api/types";
import { BILLING_HOLDS, billingHoldOf } from "../src/lib/billing";
import { errorText, holdText, standingRefusalText } from "../src/lib/errors";
import { workspaceHeadline } from "../src/lib/notifications";
import { can } from "../src/lib/permissions";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

const standingNotice = (latest: AppNotification["latest"]) => ({ kind: "org_standing" as const, latest });

describe("billing holds in words (ADR 0077)", () => {
  test("a hold whose reason is a billing code is one; nothing else is", () => {
    for (const code of BILLING_HOLDS) expect(billingHoldOf({ state: "hold", reason: code })).toBe(code);
    expect(billingHoldOf({ state: "hold", reason: "verificação de pagamento" })).toBeNull();
    expect(billingHoldOf({ state: "hold", reason: null })).toBeNull();
    expect(billingHoldOf({ state: "suspended", reason: "payment" })).toBeNull();
    expect(billingHoldOf(undefined)).toBeNull();
  });

  test("the banner, an API refusal and a refused run say the hold's own words, never its code", () => {
    for (const code of BILLING_HOLDS) {
      const words = `standing.billing.${code}`;
      expect(holdText(t, { state: "hold", reason: code })).toBe(words);
      expect(standingRefusalText(t, "run.org_paused", { reason: code })).toBe(words);
      expect(
        errorText(t, new ApiError(403, "org.paused", `This workspace is on hold: ${code}`, { reason: code })),
      ).toBe(words);
    }
    // A suspension's reason is the operator's, whatever it says.
    expect(standingRefusalText(t, "org.suspended", { reason: "payment" })).toBe(
      'standing.suspendedFor {"reason":"payment"}',
    );
  });

  test("creating another workspace while one waits for its plan: the facts, never the web's call to pay", () => {
    const refused = new ApiError(403, "org.create_unpaid", "You already have a workspace waiting for a plan", {
      orgId: "o1",
    });
    expect(errorText(t, refused)).toStartWith("standing.createInactive ");
  });

  test("the notification's headline is the hold's, the plain hold's for a code it doesn't know", () => {
    for (const code of BILLING_HOLDS)
      expect(workspaceHeadline(standingNotice({ statusTo: "hold", billingHold: code }))).toBe(
        `standing.notification.billing.${code}`,
      );
    expect(workspaceHeadline(standingNotice({ statusTo: "hold", billingHold: "trial" }))).toBe(
      "standing.notification.hold",
    );
    expect(workspaceHeadline(standingNotice({ statusTo: "active" }))).toBe("standing.notification.active");
  });

  test("owners and admins manage billing, members don't", () => {
    expect([can("owner", "manage_billing"), can("admin", "manage_billing"), can("member", "manage_billing")]).toEqual([
      true,
      true,
      false,
    ]);
  });
});
