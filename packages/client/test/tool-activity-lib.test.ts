import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { serverBody } from "../src/lib/message-body";
import { showsActivity } from "../src/lib/work";

test("a reply's tools show only for a person who turned them on: off by default and with an older server", () => {
  expect(showsActivity({ showActivity: true })).toBe(true);
  expect(showsActivity({ showActivity: false })).toBe(false);
  expect(showsActivity({})).toBe(false);
  expect(showsActivity(null)).toBe(false);
});

test("a secret request's text names who asked; one posted before that reads without a name", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const meta = (bodyParams: Record<string, string>) => ({ bodyCode: "secret_request", bodyParams });
  expect(serverBody(t, "…", meta({ agent: "Ada", name: "BILLING_API_KEY" }))).toBe("chat.body.secret_request");
  expect(serverBody(t, "…", meta({ name: "BILLING_API_KEY" }))).toBe("chat.body.secret_requestAnon");
});
