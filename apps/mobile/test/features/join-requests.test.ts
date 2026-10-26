import { describe, expect, test } from "bun:test";
import { afterSignIn, storedInvite } from "../../src/features/auth/links";
import { requestTimes } from "../../src/features/members/logic";
import { translator } from "./fixtures";

const TOKEN = "k3J8sQ2xY7pL0vB4nM6cD1eF9gH5jK2a";

describe("an invitation remembered before signing in", () => {
  test("a link's page opens again, for the account to ask; an email invitation is accepted", () => {
    expect(afterSignIn(storedInvite(TOKEN, "link"))).toEqual({ open: `/invite/${TOKEN}` });
    expect(afterSignIn(storedInvite(TOKEN, "email"))).toEqual({ accept: TOKEN });
  });

  test("a bare token from an older build is an email invitation; nothing or garbage does nothing", () => {
    expect(afterSignIn(TOKEN)).toEqual({ accept: TOKEN });
    expect(afterSignIn(null)).toBeNull();
    expect(afterSignIn("link:../../etc")).toBeNull();
    expect(afterSignIn("link:")).toBeNull();
  });
});

describe("a request to join, in the Requests sheet", () => {
  test("when it was asked and when it closes are a line each, as on the web, never run together", async () => {
    const now = new Date("2026-10-26T15:00:00.000Z");
    const r = { createdAt: "2026-10-26T13:00:00.000Z", expiresAt: "2026-11-09T13:00:00.000Z" };
    const pt = await translator("pt-BR");
    const [asked, closes] = requestTimes(pt, "pt-BR", r, now);
    expect(asked).toStartWith("Pediu ");
    expect(closes).toStartWith("Fecha em ");
    expect(`${asked}${closes}`).not.toContain(" · ");
    const en = await translator("en");
    expect(requestTimes(en, "en", r, now)[1]).toStartWith("Closes ");
  });
});
