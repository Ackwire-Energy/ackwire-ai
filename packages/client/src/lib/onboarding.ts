import type { TFunction } from "i18next";
import type { AgentInput } from "../api/types";
import { AUTO } from "./providers";
import { handleFrom } from "./text";

/** The ready-made agents a new workspace is offered (in its right hand's DM, ADR 0137), in this order. */
export const PRESETS = ["theo", "ada", "lia", "atlas"] as const;
export type Preset = (typeof PRESETS)[number];

/** Each preset's own look, saved on the agent it creates (the emails draw the same faces). */
export const PRESET_LOOK: Record<Preset, { color: string; eyes: string; accessory: string }> = {
  theo: { color: "indigo", eyes: "round", accessory: "cap" },
  ada: { color: "green", eyes: "wide", accessory: "headphones" },
  lia: { color: "rose", eyes: "dots", accessory: "flower" },
  atlas: { color: "amber", eyes: "round", accessory: "antenna" },
};

/** The "Criar agente" role whose instructions each preset starts with; Lia has her own. */
const PRESET_ROLE: Record<Preset, "pm" | "dev" | "ops" | null> = { theo: "pm", ada: "dev", lia: null, atlas: "ops" };

/** A preset as the create route takes it: on Automático and the workspace's default key. */
export function presetInput(t: TFunction, preset: Preset): AgentInput {
  const name = t(`onboarding.presets.${preset}.name`);
  const role = PRESET_ROLE[preset];
  return {
    name,
    handle: handleFrom(name),
    role: t(`onboarding.presets.${preset}.role`),
    instructions: role ? t(`newAgent.roles.${role}.instructions`) : t("onboarding.presets.lia.instructions"),
    model: AUTO,
    credentialId: null,
    appearance: PRESET_LOOK[preset],
  };
}

/**
 * The onboarding's steps, in order (the server's `ONBOARDING_STEPS`, `packages/db/src/schema/tenancy.ts`, keeps the
 * furthest one reached).
 * "import" reads another product's export (apps/web/src/lib/import); its
 * agents arrive chosen in "agents", which only picks and creates the team.
 * "computer" comes before "ai": a computer the agents can use helps that step,
 * whose plan sign-in runs on it.
 */
export const ONBOARDING_STEPS = [
  { id: "workspace", optional: false },
  { id: "context", optional: false },
  { id: "import", optional: true },
  { id: "agents", optional: false },
  { id: "computer", optional: true },
  { id: "ai", optional: false },
  { id: "team", optional: true },
  { id: "done", optional: false },
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

export const stepIndex = (id: OnboardingStepId) => ONBOARDING_STEPS.findIndex((s) => s.id === id);

/**
 * The onboarding's steps on the rail (ADR 0158), web and phone: the workspace's name, what it does, its team, and the
 * plan, which only a workspace waiting for its first plan has (agentes.chat Cloud).
 */
export type RailStep = "name" | "business" | "team" | "plan";
export const railSteps = (waitsForPlan: boolean): RailStep[] =>
  waitsForPlan ? ["name", "business", "team", "plan"] : ["name", "business", "team"];

/**
 * The step to show, read from the workspace's data (it exists, has its context, has a team, waits for its plan), so a
 * workspace left at any step resumes there; "open" once it is ready to open.
 */
export function railStepAt(f: {
  created: boolean;
  context: boolean;
  team: boolean;
  waitsForPlan: boolean;
}): RailStep | "open" {
  if (!f.created) return "name";
  if (!f.context) return "business";
  if (!f.team) return "team";
  return f.waitsForPlan ? "plan" : "open";
}

/** Where the workspace opens when the onboarding ends: #general, or its right hand's DM when the plan was left. */
export const landingOf = (how: "paid" | "done" | "skipped") => (how === "skipped" ? "rightHand" : "general");

/** What the plan step shows on each platform: the phone app never a price nor a way to pay (ADR 0079 §6). */
export const planStepShows = (platform: "web" | "phone", offer: { price?: string } | null) => ({
  price: platform === "web" && Boolean(offer?.price),
  billing: platform === "web",
});
