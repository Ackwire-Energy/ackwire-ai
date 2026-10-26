import { describe, expect, test } from "bun:test";
import { afterSignIn, storedInvite } from "../../src/features/auth/links";

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
