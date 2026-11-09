import { expect, test } from "bun:test";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { PUSH } from "../src/push/messages";
import { strings as ru } from "../src/push/messages/ru";
import { PUSH_BODY_MAX, PUSH_TITLE_MAX, pushStrings, renderPush } from "../src/push-messages";

const KINDS = [
  "approval",
  "agent_question",
  "mention",
  "dm",
  "agent_reply",
  "mission_stopped",
  "routine_failed",
  "run_failed",
  "routine_paused",
  "agent_unreached",
  "routine_stalled",
  "routine_waiting_plan",
  "plan_reset_unknown",
  "machine_connected",
  "computer_ready",
  "browser_handoff",
  "secret_request",
  "join_request",
  "device.join_request",
  "widget_alert",
  "widget_failed",
  "dashboard_proposal",
  "something_new",
];

test("every push kind in every language: words, within the phone's limits (ADR 0122)", () => {
  for (const locale of LOCALE_CODES)
    for (const kind of KINDS)
      for (const variant of [
        { actorName: "Ana", actorType: "user" as const, text: "olha", title: "Deploy", label: "geral" },
        { actorType: "agent" as const, highRisk: true, reminder: true, screen: "desktop", suggestedBy: "Bia" },
      ]) {
        const { title, body } = renderPush(locale, { kind, waiting: true, ...variant });
        expect({ locale, kind, title: title.length > 0 }).toEqual({ locale, kind, title: true });
        expect(`${title}${body}`).not.toMatch(/undefined|null|\{\{/);
        expect(title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
        expect(body.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
      }
});

test("a language without a word says it in English", () => {
  PUSH.ru = {};
  try {
    expect(pushStrings("ru").questionBody).toBe(pushStrings("en").questionBody);
  } finally {
    PUSH.ru = ru;
  }
  expect(pushStrings("ru").questionBody).not.toBe(pushStrings("en").questionBody);
  expect(pushStrings("pt-BR").questionBody).not.toBe(pushStrings("en").questionBody);
});
