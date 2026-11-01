import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { waitsForComputer } from "../src/lib/machine-outages";
import { serverBody } from "../src/lib/message-body";
import { usageWhen } from "../src/lib/plan-usage";

/** Says the key and its values, so a test reads which words were picked. */
const t = ((key: string, values: Record<string, unknown> = {}) => {
  const { defaultValue: _, ...rest } = values;
  return `${key} ${JSON.stringify(rest)}`;
}) as unknown as TFunction;

test("a note about a plan's limit or the budget says when, in the reader's zone", () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 60_000).toISOString();
  const body = serverBody(
    t,
    "fallback",
    { bodyCode: "plan_limit_cut", bodyParams: { plan: "Claude" }, usageWait: { code: "plan_limit", resetsAt: soon } },
    "en",
  );
  expect(body.startsWith("chat.body.plan_limit_cut ")).toBe(true);
  expect(body).toContain('"plan":"Claude"');
  expect(body).toContain("chat.usageWhen.");
  // Not known: the note's own words, with no time.
  expect(serverBody(t, "x", { bodyCode: "plan_limit_wait_unknown", bodyParams: { plan: "Kimi" } }, "en")).toBe(
    'chat.body.plan_limit_wait_unknown {"plan":"Kimi","when":""}',
  );
  // An older note about the limit, sent as the computer being unavailable, says the plan's words.
  expect(
    serverBody(t, "x", {
      bodyCode: "brain_unavailable",
      bodyParams: { brain: "Codex" },
      brainUnavailable: { code: "plan_limit" },
    }),
  ).toBe('chat.body.plan_limit_wait_unknown {"plan":"ChatGPT"}');
});

test("usageWhen: the time today, the weekday this week, else the date", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  expect(usageWhen(t, "en", "2026-11-04T15:40:00Z", now)).toStartWith("chat.usageWhen.at");
  expect(usageWhen(t, "pt-BR", "2026-11-06T13:00:00Z", now)).toStartWith("chat.usageWhen.on");
  expect(usageWhen(t, "pt-BR", "2026-11-06T13:00:00Z", now)).not.toContain("-feira");
  expect(usageWhen(t, "pt-BR", "2026-12-01T12:00:00Z", now)).toContain("1º de dezembro");
});

test("a plan's limit never becomes the waiting card that says the computer is back", () => {
  expect(waitsForComputer({ machineId: "m1", code: "machine_offline" })).toBe(true);
  expect(waitsForComputer({ machineId: "m1", code: "plan_limit" })).toBe(false);
  expect(waitsForComputer({ machineId: "m1", code: "busy" })).toBe(false);
  expect(waitsForComputer({ machineId: null, code: "machine_offline" })).toBe(false);
});
