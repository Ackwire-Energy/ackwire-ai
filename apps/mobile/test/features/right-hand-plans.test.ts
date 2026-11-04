import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The team's right hand on a plan (ADR 0137 §1, §7) on the phone: components the tests can't render, read as text. */
const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/ai", path), "utf8");

test("its plan's line: one plain line and Usar uma chave de API, which opens Connect on the key", () => {
  const card = source("NoAiCard.tsx");
  expect(card).toContain("noAi.rightHand.");
  expect(card).toContain('label={t("noAi.rightHand.useKey")}');
  expect(card).toContain('openConnectAi({ from: m.id, intent: "api_key", agentId: card.agentId })');
});

test("Connect for it offers only the plans through Claude Code, and its key moves it off the plan", () => {
  const sheet = source("ConnectAi.tsx");
  expect(sheet).toContain("claudeCodeOnly={rightHand}");
  expect(sheet).toContain('setBrain(orgId, one.id, { brain: "model" })');
  const steps = source("ConnectAiSteps.tsx");
  expect(steps).toContain('(claudeCodeOnly ? (["claude"] as const) : (["claude", "chatgpt"] as const))');
});

test("Settings › Lodi: the plan row opens Connect, and Atende outras pessoas is there for whoever sets its AI", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  expect(screen).toContain('t("rightHand.settings.onPlan"');
  expect(screen).toContain('label={t("rightHand.settings.usePlan")}');
  expect(screen).toContain("openConnectAi({ agentId: agent.id })");
  // As for any agent on its owner's plan: an admin may override (the plan's owner hears it by email).
  expect(screen).toContain("<PlanReplies");
  expect(screen).toContain(".setBrain(orgId, agent.id, { onlyOwner: !on })");
  expect(screen).toContain("disabled={!view.canEdit}");
  expect(screen).toContain('agent.brain?.kind === "claude_code" || agent.brain?.kind === "opencode"');
});
