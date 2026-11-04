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

test("Connect for it offers every plan the phone offers, ChatGPT's too, and its key moves it off the plan", () => {
  const sheet = source("ConnectAi.tsx");
  expect(sheet).not.toContain("claudeCodeOnly");
  expect(sheet).toContain('setBrain(orgId, one.id, { brain: "model" })');
  const steps = source("ConnectAiSteps.tsx");
  expect(steps).toContain('(["claude", "chatgpt", "grok", "gemini"] as const).map(');
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
  // Any plan's CLI: Claude Code's, Codex's, Cursor's, OpenCode's, Grok Build's or the Antigravity CLI's.
  expect(screen).toContain('agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null');
  expect(screen).toContain("t(`aiAccounts.connect.$" + "{kind}`)");
});
