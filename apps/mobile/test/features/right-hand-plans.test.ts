import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The team's right hand on a plan (ADR 0137 §1, §7) on the phone: components the tests can't render, read as text. */
const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/ai", path), "utf8");

test("its plan's line: one plain line and Usar uma chave de API, which opens Connect on the key", () => {
  const card = source("NoAiCard.tsx");
  expect(card).toContain("noAi.rightHand.");
  expect(card).toContain('"noAi.rightHand.useKey"');
  expect(card).toContain('{ intent: "api_key" }');
  // The workspace's plan serves only its owner: the person's own plan answers them (ADR 0137 §11).
  expect(card).toContain('fix === "connectMine" ? "rightHand.settings.connectMine"');
});

test("Connect for it offers every plan the phone offers, ChatGPT's too, and its key moves it off the plan", () => {
  const sheet = source("ConnectAi.tsx");
  expect(sheet).not.toContain("claudeCodeOnly");
  expect(sheet).toContain("rightHandOnKey(api, orgId, one, key");
  const steps = source("ConnectAiSteps.tsx");
  expect(steps).toContain("options={PLAN_CHOICES.map((c) => ({");
});

test("Sua IA is one status: what answers me, by its logo and what it is to me, and its action; Lodi's settings drop it", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  const profile = readFileSync(join(import.meta.dir, "../../src/features/agents/AgentProfileScreen.tsx"), "utf8");
  // The four states come from the client's rule, as on the web (ADR 0137 §11).
  expect(screen).toContain('const status = mineStatus(view, meId ?? "", platform, agent.brain?.maker);');
  for (const kind of ["own", "key", "plan"]) expect(screen).toContain(`status.kind === "${kind}"`);
  // A plan of mine or lent to me: its maker's logo, whose it is, Trocar, and back to the workspace's in one tap.
  expect(screen).toContain('leading={<ProviderLogo id={status.brain} size="sm" />}');
  expect(screen).toContain('t("rightHand.settings.mineOf", { owner: first(status.ownerId) })');
  expect(screen).toContain('{ scope: "mine", brain: "model" }');
  // The workspace's key or plan answers me: what it is, and Usar meu plano.
  expect(screen).toContain('sub={t("rightHand.settings.mineKey")}');
  expect(screen).toContain('sub={t("rightHand.settings.minePlan")}');
  expect(screen.match(/value=\{t\("rightHand\.settings\.useMine"\)\}/g)).toHaveLength(2);
  // Nobody answers me: the call to connect my plan, and why it is mine alone behind the ⓘ, not a paragraph under it.
  expect(screen).toContain('sub={t("rightHand.settings.mineNobody")}');
  expect(screen).toContain('text: t("rightHand.settings.mineHelp", agentGrammar(agent.name)),');
  expect(screen).not.toContain("rightHandFallback");
  expect(screen).toContain("openConnectAi({ agentId: agent.id })");
  // On the right hand's profile; Configurações › Lodi is the team's settings and drops it.
  expect(profile).toContain("<RightHandMine agent={agent} />");
  expect(screen.match(/<RightHandMine/g)).toBeNull();
});

test("Settings › Lodi: the workspace's plan keeps Atende outras pessoas for whoever sets its AI", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  // The workspace's AI is read and saved as such; the look opens from the row, with no "Mudar visual" on it.
  expect(screen).toContain('useAgentBrain(orgId, agent.id, true, false, "workspace")');
  expect(screen).toContain('{ scope: "workspace", ...input }');
  expect(screen).not.toContain("rightHand.settings.changeLook");
  // As for any agent on its owner's plan: an admin may override (the plan's owner hears it by email).
  expect(screen).toContain('label={t("aiAccounts.share.switch")}');
  expect(screen).toContain("set({ onlyOwner: on })");
  expect(screen).toContain("disabled={!view.canEdit}");
  // Any plan's CLI: Claude Code's, Codex's, Cursor's, OpenCode's, Grok Build's or the Antigravity CLI's.
  expect(screen).toContain('agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null');
  expect(screen).toContain("t(`aiAccounts.connect.$" + "{kind}`)");
});

test("Connect is everyone's for Lodi, and its own AI has no Atende outras pessoas", () => {
  const sheet = source("ConnectAi.tsx");
  expect(sheet).toContain("a.ownerUserId === meId || isRightHand(a)");
  const steps = source("ConnectAiSteps.tsx");
  expect(steps).toContain('gates.view?.scope === "mine" ? null : (');
  expect(steps).toContain('t("noAi.lockedOwner")');
});
