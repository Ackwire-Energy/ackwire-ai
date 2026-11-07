import type { TFunction } from "i18next";
import type { Agent, AgentSetupChecklist, AudienceMode, SetupStep } from "../api/types";
import type { Level } from "./access-levels";
import { presetChannels, ROLE_DEFAULTS, ROLE_IDS, type RoleId } from "./new-agent";

/*
 * A new agent's setup checklist (ADR 0152 §2): the top of its chat, in its voice, lists what it still needs. The
 * server keeps the role it started from and the steps a person confirmed; a step is also done when the agent's data
 * says so (an AI that works, an app it may use, a channel it is in). These are the rules the apps share.
 */

export const SETUP_STEPS: readonly SetupStep[] = ["ai", "apps", "where", "who", "how"];

/** Only who manages agents changes its apps and how it works; its owner changes its AI, channels and audience. */
const ADMIN_STEPS: ReadonlySet<SetupStep> = new Set<SetupStep>(["apps", "how"]);

/** The ready-made role it started from, if the apps know it ("custom" is from scratch: none). */
export const setupRole = (setup: AgentSetupChecklist | null | undefined): RoleId | null =>
  setup?.role && setup.role !== "custom" && (ROLE_IDS as readonly string[]).includes(setup.role)
    ? (setup.role as RoleId)
    : null;

/**
 * The steps this person sees, in order: who manages agents, all of them; its owner, the ones they may change; anyone
 * else, none (the checklist is for who sets the agent up). An agent made before the checklist, or the right hand: none.
 */
export function setupSteps(
  agent: Pick<Agent, "setup" | "ownerUserId" | "builtin">,
  viewer: { meId: string; admin: boolean },
): SetupStep[] {
  if (!agent.setup || agent.builtin) return [];
  if (viewer.admin) return [...SETUP_STEPS];
  if (agent.ownerUserId !== viewer.meId) return [];
  return SETUP_STEPS.filter((s) => !ADMIN_STEPS.has(s));
}

/** What the agent's data says, so a step done some other way (its page, a card) is done here too. */
export interface SetupFacts {
  /** Its AI works, or waits for its computer (not "no AI"). */
  ai?: boolean;
  /** It may use at least one app. */
  apps?: boolean;
  /** It is in at least one channel (DMs aside). */
  where?: boolean;
}

/** The steps done: confirmed by a person, or done as its data says. */
export function setupDone(setup: AgentSetupChecklist, facts: SetupFacts): Set<SetupStep> {
  const done = new Set<SetupStep>(setup.done);
  if (facts.ai) done.add("ai");
  if (facts.apps) done.add("apps");
  if (facts.where) done.add("where");
  return done;
}

/** The first step not done yet (the one whose button is the primary one), or null. */
export const nextStep = (steps: readonly SetupStep[], done: ReadonlySet<SetupStep>) =>
  steps.find((s) => !done.has(s)) ?? null;

/** The apps (catalog connector ids) its role suggests, at their levels; none for an agent from scratch. */
export const suggestedLevels = (role: RoleId | null): Record<string, Level> => (role ? ROLE_DEFAULTS[role].levels : {});

/**
 * The channels its role suggests among the ones given (by name); with none, the workspace's general channel, where
 * mentions reach it.
 */
export function suggestedChannels<C extends { id: string; name: string }>(
  role: RoleId | null,
  channels: C[],
): string[] {
  const picked = role ? presetChannels(role, channels) : [];
  if (picked.length > 0) return picked;
  const general = channels.find((c) => c.name === "general" || c.name === "geral");
  return general ? [general.id] : [];
}

/** How many first tasks a ready-made role suggests (`newAgent.roles.{id}.tasks.{a,b,c}`) and a blank one. */
export const TASK_KEYS = ["a", "b", "c"] as const;
export const BLANK_TASK_KEYS = ["a", "b"] as const;

/** One line of instructions short enough to say back ("Você me pediu: …"): what an agent from scratch was asked. */
export function askedLine(instructions: string): string | null {
  const text = instructions.trim();
  return text && !text.includes("\n") && text.length <= 200 ? text : null;
}

/** The keys of its first tasks: a ready-made role's three, or a blank agent's own two. */
export const setupTaskKeys = (role: RoleId | null): string[] =>
  role
    ? TASK_KEYS.map((k) => `newAgent.roles.${role}.tasks.${k}`)
    : BLANK_TASK_KEYS.map((k) => `agentSetup.tasks.${k}`);

/** What a row says, from what the app read: names already joined in the person's language. */
export interface SetupRowFacts {
  org: string;
  role: RoleId | null;
  /** The apps it may use ("o Gmail e o Drive"), and the ones its role suggests; null when none. */
  granted: string | null;
  suggested: string | null;
  /** The channels it is in ("#suporte e #geral"), and the first one its role suggests ("#suporte"); null when none. */
  channels: string | null;
  firstChannel: string | null;
  audience: AudienceMode;
  /** Its owner's first name when that isn't the person reading; null for them, or nobody. */
  otherOwner: string | null;
  /** It thinks with someone's plan (whose terms say who it may answer). */
  onPlan: boolean;
}

/** One row of the checklist, in the agent's voice: what it says, a line under it while left, its button's word. */
export interface SetupRow {
  title: string;
  desc?: string;
  action: string;
}

/** A row's words (the web's dialog buttons and the phone's screens say the same). */
export function setupRow(t: TFunction, step: SetupStep, done: boolean, f: SetupRowFacts): SetupRow {
  switch (step) {
    case "ai":
      return done
        ? { title: t("agentSetup.ai.done"), action: t("agentSetup.switch") }
        : { title: t("agentSetup.ai.todo"), desc: t("agentSetup.ai.todoDesc"), action: t("agentSetup.ai.action") };
    case "apps":
      if (done) {
        return {
          title: f.granted ? t("agentSetup.apps.done", { apps: f.granted }) : t("agentSetup.apps.doneNone"),
          action: t("agentSetup.change"),
        };
      }
      return f.suggested
        ? {
            title: t("agentSetup.apps.todo", { apps: f.suggested }),
            desc: t("agentSetup.apps.todoDesc"),
            action: t("agentSetup.apps.action"),
          }
        : {
            title: t("agentSetup.apps.todoNone", { org: f.org }),
            desc: t("agentSetup.apps.todoNoneDesc"),
            action: t("agentSetup.choose"),
          };
    case "where":
      if (done) {
        return {
          title: f.channels ? t("agentSetup.where.done", { channels: f.channels }) : t("agentSetup.where.doneNone"),
          action: t("agentSetup.change"),
        };
      }
      return f.firstChannel
        ? {
            title: t("agentSetup.where.todo", { channel: f.firstChannel }),
            desc: t("agentSetup.where.todoDesc"),
            action: t("agentSetup.where.action"),
          }
        : {
            title: t("agentSetup.where.todoNone"),
            desc: t("agentSetup.where.todoDesc"),
            action: t("agentSetup.choose"),
          };
    case "who":
      if (done) {
        const title =
          f.audience === "everyone"
            ? t("agentSetup.who.doneEveryone", { org: f.org })
            : f.audience === "owner"
              ? f.otherOwner
                ? t("agentSetup.who.doneOwner", { name: f.otherOwner })
                : t("agentSetup.who.doneYou")
              : t("agentSetup.who.donePeople");
        return { title, action: t("agentSetup.change") };
      }
      return f.onPlan
        ? {
            title: t("agentSetup.who.todoPlan"),
            desc: t("agentSetup.who.todoPlanDesc"),
            action: t("agentSetup.choose"),
          }
        : {
            title: t("agentSetup.who.todo", { org: f.org }),
            desc: t("agentSetup.who.todoDesc"),
            action: t("agentSetup.choose"),
          };
    case "how":
      return done
        ? { title: t("agentSetup.how.done"), action: t("agentSetup.see") }
        : {
            title: t("agentSetup.how.todo"),
            desc: f.role
              ? t("agentSetup.how.todoDesc", { role: t(`newAgent.roles.${f.role}.name`) })
              : t("agentSetup.how.todoDescBlank"),
            action: t("agentSetup.see"),
          };
  }
}
