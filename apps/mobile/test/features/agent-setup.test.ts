import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type SetupRowFacts, setupRow, setupSteps } from "@agenteschat/client/lib/setup-checklist";
import { agent, translator } from "./fixtures";

// A new agent's setup checklist on the phone (ADR 0152 §2): the web's words and rules, its own screens.

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

const facts: SetupRowFacts = {
  org: "Acme",
  role: "support",
  granted: null,
  suggested: null,
  channels: null,
  firstChannel: "#suporte",
  audience: "everyone",
  otherOwner: null,
  onPlan: false,
};

test("its rows say what the web's say, in the agent's voice", async () => {
  const t = await translator("pt-BR");
  expect(setupRow(t, "ai", false, facts).title).toBe("Conectar uma IA");
  expect(setupRow(t, "where", false, facts).title).toBe("Entrar em #suporte");
  expect(setupRow(t, "who", true, { ...facts, audience: "owner" }).title).toBe("Falo só com você");
  const en = await translator("en");
  expect(setupRow(en, "where", false, facts).title).toBe("Join #suporte");
});

test("who sees it on the phone: who manages agents every step, its owner theirs, the right hand none", () => {
  const leo = agent({ id: "a-leo", name: "Leo", ownerUserId: "u-owner", setup: { role: "sales", done: [] } });
  expect(setupSteps(leo, { meId: "u-admin", admin: true })).toEqual(["ai", "apps", "where", "who", "how"]);
  expect(setupSteps(leo, { meId: "u-owner", admin: false })).toEqual(["ai", "where", "who"]);
  expect(setupSteps({ ...leo, builtin: "right_hand" }, { meId: "u-admin", admin: true })).toEqual([]);
  expect(setupSteps({ ...leo, setup: null }, { meId: "u-admin", admin: true })).toEqual([]);
});

test("the DM draws the checklist on top for whoever sets it up, not the first day nor the no-AI line", () => {
  const chat = src("chat/ChatScreen.tsx");
  expect(chat).toContain("const setupIntro = useSetupSteps(dmAgent).length > 0 && !rightHand && !isThread;");
  expect(chat).toContain("member && !rightHand && !setupIntro");
  expect(chat.match(/<AgentSetupIntro agent=\{dmAgent\} channelId=\{channelId\} \/>/g)?.length).toBe(2);
  // Its screen shows the same card while something is left.
  expect(src("agents/AgentProfileScreen.tsx")).toContain('<AgentSetupCard agent={agent} place="profile" />');
});

test("each step but thinking is a pushed screen, registered in the stack; thinking opens Connect AI", () => {
  const card = src("agents/setup/SetupCard.tsx");
  expect(card).toContain('if (step === "ai") openConnectAi({ agentId: agent.id });');
  expect(card).toContain("else openSetupStep(agent.id, step);");
  const layout = readFileSync(new URL("../../app/(app)/_layout.tsx", import.meta.url), "utf8");
  expect(layout).toContain('<Stack.Screen name="agent-step/[id]" options={{ ...pushed, ...scrollUnder }} />');
  const steps = src("agents/setup/SetupStepScreen.tsx");
  // Nothing saves until its word on the bar; then the step is confirmed and the screen goes back.
  expect(steps).toContain("await confirm.mutateAsync(step);");
  expect(steps).toContain("goBack();");
});
