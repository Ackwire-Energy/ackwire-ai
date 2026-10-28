import { describe, expect, test } from "bun:test";
import { exampleSenders, MAX_PUSH_OFFERS, pushOfferDue, pushOffersFrom } from "../src/lib/push-offer";

describe("our notifications sheet, before the system's prompt", () => {
  const fresh = { permission: "undetermined" as const, turnedOff: false, offers: 0 };

  test("once when the home loads, once more at the first request to approve, then never", () => {
    expect(pushOfferDue(fresh, "home")).toBe(true);
    expect(pushOfferDue(fresh, "approval")).toBe(false);
    expect(pushOfferDue({ ...fresh, offers: 1 }, "home")).toBe(false);
    expect(pushOfferDue({ ...fresh, offers: 1 }, "approval")).toBe(true);
    expect(pushOfferDue({ ...fresh, offers: 2 }, "approval")).toBe(false);
  });

  test("never once the phone was asked, or when the person turned them off", () => {
    expect(pushOfferDue({ ...fresh, permission: "granted" }, "home")).toBe(false);
    expect(pushOfferDue({ ...fresh, permission: "denied" }, "home")).toBe(false);
    expect(pushOfferDue({ ...fresh, permission: null }, "home")).toBe(false);
    expect(pushOfferDue({ ...fresh, turnedOff: true }, "home")).toBe(false);
  });

  test("the stored count; a phone the old flow already asked gets none", () => {
    expect(pushOffersFrom(null, false)).toBe(0);
    expect(pushOffersFrom("1", false)).toBe(1);
    expect(pushOffersFrom("9", false)).toBe(MAX_PUSH_OFFERS);
    expect(pushOffersFrom("x", false)).toBe(0);
    expect(pushOffersFrom(null, true)).toBe(MAX_PUSH_OFFERS);
  });

  test("the examples come from the workspace's agents", () => {
    expect(exampleSenders(["Dev", "Infra", "Vendas", "Pesquisa"], "Um agente")).toEqual(["Dev", "Infra", "Vendas"]);
    expect(exampleSenders(["Dev", "Dev ", ""], "Um agente")).toEqual(["Dev", "Dev", "Dev"]);
    expect(exampleSenders([], "Um agente")).toEqual(["Um agente", "Um agente", "Um agente"]);
  });
});
