import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { serverBody } from "../src/lib/message-body";
import { noAiCardOf } from "../src/lib/no-ai";

/** The team's right hand on a plan (ADR 0137 §1, §7), as the web and the phone read it. */

const meta = (reason: string) => ({
  bodyCode: "no_ai",
  noAi: { agentId: "lodi", forUserId: null, reason, intent: "task", runId: "r1" },
});

test("its plan's line: the computer away, the limit, a plan for its owner only; anything else is an ordinary card", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  for (const reason of ["computer_away", "plan_limit", "plan_not_shared"]) {
    expect(noAiCardOf(meta(reason))?.planLine).toBe(reason as never);
    expect(serverBody(t, "…", meta(reason))).toBe(`chat.body.no_ai_${reason}`);
  }
  expect(noAiCardOf(meta("no_key"))?.planLine).toBeUndefined();
  expect(noAiCardOf(meta("not_signed_in"))?.planLine).toBeUndefined();
});

test("a runner to update and a CLI with tools of its own are lines of their own, not 'no AI'", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  for (const reason of ["runner_outdated", "plan_tools"]) {
    expect(noAiCardOf(meta(reason))?.planLine).toBe(reason as never);
    expect(serverBody(t, "…", meta(reason))).toBe(`chat.body.no_ai_${reason}`);
  }
});
