import { isEmail } from "@agenteschat/client/lib/text";
import type { AgentColorName, EyeStyle } from "@agenteschat/ui/agent/engine";
import type { TFunction } from "i18next";
import { joinNames } from "../shared/logic";

/**
 * The phone's first run: one question per full screen, hosted by an
 * agent of the team, a strip of sky on top that fills as you go. The web's steps without the computer's. Pure: no
 * React Native imports.
 */
export const STEPS = ["workspace", "context", "import", "agents", "ai", "team", "done"] as const;
export type StepId = (typeof STEPS)[number];

/** Steps that can be skipped. */
export const OPTIONAL: ReadonlySet<StepId> = new Set(["import", "ai", "team"]);

/** The presets of the web's onboarding, with the same looks and roles. */
export const PRESETS = ["ada", "theo", "lia", "atlas"] as const;
export type Preset = (typeof PRESETS)[number];

export const PRESET_LOOK: Record<Preset, { color: AgentColorName; eyes: EyeStyle; accessory: string }> = {
  theo: { color: "indigo", eyes: "round", accessory: "cap" },
  ada: { color: "green", eyes: "wide", accessory: "headphones" },
  lia: { color: "rose", eyes: "dots", accessory: "flower" },
  atlas: { color: "amber", eyes: "round", accessory: "antenna" },
};

/** The instructions each preset starts with (the roles of "Criar agente"; Lia has her own). */
export const PRESET_ROLE: Record<Preset, "pm" | "dev" | "ops" | null> = {
  theo: "pm",
  ada: "dev",
  lia: null,
  atlas: "ops",
};

/** The guide: always on the team ("Eu já estou aqui"), and the DM the onboarding ends in. */
export const GUIDE: Preset = "ada";

/** Who hosts each step (introducing itself the first time it appears). */
export const HOST: Record<StepId, Preset> = {
  workspace: "ada",
  context: "lia",
  import: "theo",
  agents: "ada",
  ai: "ada",
  team: "theo",
  done: "ada",
};

/**
 * A step's question and the one line under it. The phone can't import, so its import step says where to; the
 * agents step has its own (Ada is a row of its own here); the team step has none (the link and the emails say it).
 */
export function stepText(
  t: TFunction,
  step: StepId,
  { org, chosen, aiSaved }: { org: string; chosen: ReadonlySet<Preset>; aiSaved: boolean },
): [title: string, lead?: string] {
  switch (step) {
    case "workspace":
      return [t("onboarding.workspace.title"), t("onboarding.workspace.lead")];
    case "context":
      return [t("onboarding.context.title"), t("onboarding.context.lead")];
    case "import":
      return [t("onboarding.import.title"), t("mobile.onb.importLead")];
    case "agents":
      return [t("onboarding.agents.title"), t("mobile.onb.agentsLead")];
    case "ai":
      return [t("onboarding.keyStep.title"), aiSaved ? t("connectAi.key.saved") : t("onboarding.keyStep.lead")];
    case "team":
      return [t("onboarding.team.title")];
    case "done": {
      const names = PRESETS.filter((p) => chosen.has(p)).map((p) => t(`onboarding.presets.${p}.name`));
      const lead =
        names.length === 0
          ? t("onboarding.done.textNone")
          : t(names.length === 1 ? "onboarding.done.inGeneralOne" : "onboarding.done.inGeneralMany", {
              names: joinNames(names, t("newAgent.and")),
            });
      return [t("onboarding.done.title", { org }), lead];
    }
  }
}

/** Where the strip of sky is at a step (0 at the first, 1 when done). */
export function progressAt(step: StepId): number {
  const i = STEPS.indexOf(step);
  return step === "done" ? 1 : i / (STEPS.length - 1);
}

/** The first step each host appears in (it says hi there; later it is just its name and role). */
export function introducesAt(step: StepId): boolean {
  const host = HOST[step];
  return STEPS.find((s) => HOST[s] === host) === step;
}

/** The next and previous steps. */
export const nextStep = (step: StepId): StepId => STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(step) + 1)] ?? "done";
export const prevStep = (step: StepId): StepId | null => {
  const i = STEPS.indexOf(step);
  return i > 0 && step !== "done" ? (STEPS[i - 1] ?? null) : null;
};

/**
 * E-mails typed or pasted ("rafael@acme.com, bia@acme.com"): lower-cased, without repeats, the ones that look
 * wrong kept apart (marked, not invited).
 */
export function emailsFrom(text: string, already: string[] = []): { valid: string[]; invalid: string[] } {
  const seen = new Set(already.map((e) => e.toLowerCase()));
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const email = raw.trim().replace(/^<|>$/g, "").toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    (isEmail(email) ? valid : invalid).push(email);
  }
  return { valid, invalid };
}

/** The phone's time zone ("America/Sao_Paulo"), or null. */
export function phoneTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "America/Sao_Paulo" → "Sao Paulo": the city, readable. */
export function zoneCity(zone: string): string {
  const city = zone.split("/").pop() ?? zone;
  return city.replace(/_/g, " ");
}

/**
 * The time zone as people read it, in their language ("Horário Padrão de Brasília"); its city ("Sao Paulo", from the
 * id, without accents) where the platform has no name for it, or only an offset ("GMT-03:00").
 */
export function zoneLabel(zone: string, locale: string): string {
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    if (name && !/^(GMT|UTC)/.test(name)) return name;
  } catch {
    // An engine without generic zone names, or an unknown zone.
  }
  return zoneCity(zone);
}
