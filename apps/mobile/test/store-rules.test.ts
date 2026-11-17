import { describe, expect, test } from "bun:test";
import { lookUpStep } from "../src/features/auth/human-check";
import { saysWhereToPay, signUpInApp, webPathOpens } from "../src/lib/store-rules";

describe("what the iPhone app leaves out for the App Store", () => {
  test("where the plan is paid is said only off iOS, and only to who may pay", () => {
    expect(saysWhereToPay(true, "android")).toBe(true);
    expect(saysWhereToPay(false, "android")).toBe(false);
    expect(saysWhereToPay(true, "ios")).toBe(false);
  });

  test("accounts are not made on iOS on agentes.chat's own servers, and are anywhere else", () => {
    expect(signUpInApp("ios", true)).toBe(false);
    expect(signUpInApp("ios", false)).toBe(true);
    expect(signUpInApp("ios", undefined)).toBe(true);
    expect(signUpInApp("android", true)).toBe(true);
  });

  test("a new e-mail reads as sign-up closed where the phone makes no account", () => {
    const fresh = { account: false, password: false, providers: [], canSignUp: true } as never;
    expect(lookUpStep(fresh, false)).toBe("name");
    expect(lookUpStep(fresh, false, false)).toBe("closed");
    // An account that exists signs in as always.
    const known = { account: true, password: true, providers: [], canSignUp: false } as never;
    expect(lookUpStep(known, false, false)).toBe("password");
  });

  test("only the plan's page stays closed on iOS", () => {
    expect(webPathOpens("/org/o1/settings/billing", "ios")).toBe(false);
    expect(webPathOpens("/org/o1/settings/billing?paid=1", "ios")).toBe(false);
    expect(webPathOpens("/org/o1/settings/billing", "android")).toBe(true);
    expect(webPathOpens("/org/o1/settings/roles", "ios")).toBe(true);
  });
});
