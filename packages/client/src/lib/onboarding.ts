import type { TFunction } from "i18next";
import type { AgentInput, AgentLookInput } from "../api/types";
import { AUTO } from "./providers";
import { addressesIn, handleFrom } from "./text";

/** The ready-made agents a new workspace is offered (in its right hand's DM, ADR 0134), in this order. */
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
 * Where a resumed onboarding opens: the furthest step the server keeps, or further where the workspace shows the
 * person got there (an older app could have saved a step behind them). The team is kept once its guide is made
 * (`guide`) and, saved at the import, once that import came in (`imported`): a creation cut short opens where it was,
 * where keeping the team again makes it whole. Past the team, a computer step with nothing to ask (`computerDone`: the
 * workspace's own computer, nothing held over it) is behind them too.
 */
export function resumeAt(
  saved: OnboardingStepId,
  shows: { guide: boolean; imported: boolean; computerDone?: boolean },
) {
  if (!shows.guide || (saved === "import" && !shows.imported)) return stepIndex(saved);
  return Math.max(stepIndex(saved), stepIndex(shows.computerDone ? "ai" : "computer"));
}

/**
 * Whether the server's answer to a step just saved (`saveOnboarding`) says the onboarding went further in another
 * window or on another device, or was finished there: the app asks for `me` again and follows it.
 */
export const aheadOf = (answer: { step: OnboardingStepId; finished: boolean }, saved: OnboardingStepId) =>
  answer.finished || stepIndex(answer.step) > stepIndex(saved);

/** A ready-made agent as the onboarding makes it: its name, handle and look. */
export interface PresetMark {
  name: string;
  handle: string;
  color: string;
  eyes: string;
  accessory: string;
}

/**
 * The agents an onboarding already made in its workspace, from its agents (oldest first): the ready-made ones by
 * preset, told by name and look (by name and handle when it has no look, a create cut short before saving it), and
 * the rest (imported). A resumed onboarding picks its team up from here.
 */
export function crewOf<
  P extends string,
  A extends { name: string; handle: string; appearance?: AgentLookInput | null },
>(
  agents: readonly A[],
  presets: readonly P[],
  markOf: (preset: P) => PresetMark,
): { presets: Partial<Record<P, A>>; others: A[] } {
  const made: Partial<Record<P, A>> = {};
  const others: A[] = [];
  for (const agent of agents) {
    const look = agent.appearance;
    const preset = presets.find((p) => {
      const mark = markOf(p);
      const same = look
        ? look.color === mark.color && look.eyes === mark.eyes && look.accessory === mark.accessory
        : agent.handle === mark.handle;
      return !made[p] && agent.name === mark.name && same;
    });
    if (preset) made[preset] = agent;
    else others.push(agent);
  }
  return { presets: made, others };
}

/**
 * Who offers the first message when the onboarding ends: the first of these on the team. Lia's research needs a
 * browser, which only a ready computer gives the agents (not one being prepared); Theo's plan needs nothing. Ada, the
 * guide, is always on the team.
 */
export const firstAskOrder = (browser: boolean) =>
  browser ? (["lia", "theo", "ada"] as const) : (["theo", "lia", "ada"] as const);

/** A person to invite, as a chip: invalid addresses stay (marked) so they can be fixed or removed. */
export interface InviteDraft {
  email: string;
  /** Invited with the workspace's administrator role (`adminRoleId`). */
  admin: boolean;
  valid: boolean;
}

/** Typed or pasted text turned into chips after the ones already there (new addresses only, `addressesIn`). */
export function addInvites(list: InviteDraft[], text: string, admin = false): InviteDraft[] {
  const known = new Set(list.map((i) => i.email));
  const added = addressesIn(text)
    .filter((a) => !known.has(a.email))
    .map((a) => ({ ...a, admin }));
  return added.length ? [...list, ...added] : list;
}

/** The invites that will be sent. */
export const validInvites = (list: InviteDraft[]) => list.filter((i) => i.valid);
