import type { AgentLookInput, AiStatus, Edition, OrgOnboarding, OrgSummary } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { crewOf, firstAskOrder, type OnboardingStepId, stepIndex } from "@agenteschat/client/lib/onboarding";
import { platformZoneName } from "@agenteschat/client/lib/routines";
import { handleFrom, isEmail } from "@agenteschat/client/lib/text";
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

/** The step the server keeps (the web's, `ONBOARDING_STEPS`) for a phone step: its "ai" is part of "agents". */
export const serverStepOf = (step: StepId): OnboardingStepId => (step === "ai" ? "agents" : step);

/** Where the phone resumes a step the server keeps: with no computer step, at the agents. */
export const phoneStepOf = (step: OnboardingStepId): StepId => (step === "computer" ? "agents" : step);

/** The step to save moving on to `next`, past the furthest one the server has from here (`reached`); else none. */
export function stepToSave(next: StepId, reached: number): OnboardingStepId | null {
  const step = serverStepOf(next);
  return stepIndex(step) > reached ? step : null;
}

/**
 * Whether the workspace a create gave back was taken past its first steps elsewhere (one being set up on the web
 * comes back instead of a new one): the resume opens it as it is, nothing typed here written over it.
 */
export function setUpElsewhere(orgs: readonly OrgSummary[] | undefined, orgId: string): boolean {
  const step = orgs?.find((o) => o.id === orgId)?.onboarding?.step;
  return step !== undefined && stepIndex(step) > stepIndex("context");
}

/** The presets of the web's onboarding, in its order (the order they are created in), with the same looks and roles. */
export const PRESETS = ["theo", "ada", "lia", "atlas"] as const;
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

/** The guide: always on the team ("Eu já estou aqui"), so the count of agents to create leaves her out. */
export const GUIDE: Preset = "ada";

/** The agents step's rows: the guide first (she is already here), then the others in the team's order. */
export const PRESET_ROWS: readonly Preset[] = [GUIDE, ...PRESETS.filter((p) => p !== GUIDE)];

/** Who is on the team at first: everyone, as on the web. */
export const DEFAULT_TEAM: readonly Preset[] = PRESETS;

/** "Criar N agentes": the chosen ones still to create, besides the guide (as on the web). */
export const joiningLeft = (chosen: ReadonlySet<Preset>, created: Partial<Record<Preset, string>>) =>
  PRESETS.filter((p) => p !== GUIDE && chosen.has(p) && !created[p]).length;

/** An agent of the workspace, as much as telling a ready-made one needs. */
type ListedAgent = { id: string; name: string; handle: string; appearance?: AgentLookInput | null };

/**
 * The ready-made agents a workspace has already (made here, on the web, or by a create cut short), told as the
 * web tells them (`crewOf`): their ids and handles by preset.
 */
export function presetsMade(t: TFunction, agents: readonly ListedAgent[]) {
  const made = crewOf(agents, PRESETS, (p) => {
    const name = t(`onboarding.presets.${p}.name`);
    return { name, handle: handleFrom(name), ...PRESET_LOOK[p] };
  }).presets;
  const ids: Partial<Record<Preset, string>> = {};
  const handles: Partial<Record<Preset, string>> = {};
  for (const p of PRESETS) {
    const agent = made[p];
    if (!agent) continue;
    ids[p] = agent.id;
    handles[p] = agent.handle;
  }
  return { ids, handles };
}

/**
 * What a resume restores of the workspace being set up (`onboarding` in `me`, and its agents): where it got, on the
 * phone's steps; the team it has, which stays picked (the guide always, no other); the furthest step reached.
 */
export function resumeOf(t: TFunction, saved: OrgOnboarding & { orgId: string }, agents: readonly ListedAgent[]) {
  const { ids, handles } = presetsMade(t, agents);
  const kept = PRESETS.filter((p) => ids[p]);
  return {
    created: { orgId: saved.orgId, generalChannelId: saved.generalChannelId },
    ids,
    handles,
    chosen: kept.length > 0 ? new Set<Preset>([GUIDE, ...kept]) : null,
    reached: stepIndex(saved.step),
    step: phoneStepOf(saved.step),
  };
}

/**
 * The import step's rows: the three most used apps the web brings agents from, in its order (its `IMPORT_CARDS`). The
 * phone can't read their files; it names them and says where on the web they come in.
 */
export const IMPORT_ROWS = ["grok-bot", "chatgpt-dots", "openbotrun"] as const;
export type ImportRow = (typeof IMPORT_ROWS)[number];

/** Brand names, not translated (the web's card names). */
export const IMPORT_BRAND: Record<ImportRow, string> = {
  "grok-bot": "Grok Bot",
  "chatgpt-dots": "ChatGPT dots",
  openbotrun: "OpenBot.run",
};

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
 * A self-hosted workspace with no computer yet. The phone has no computer step, so its list says it: only once it
 * came back empty, never while it loads.
 */
export const noComputerOf = (edition: Edition | null, machines: readonly unknown[] | undefined) =>
  edition === "selfhost" && machines?.length === 0;

/**
 * A step's question and the one line under it. The phone can't import, so its import step says where to; the
 * agents step has its own (Ada is a row of its own here); the team step has none (the link and the emails say it).
 * `noComputer`: a self-hosted workspace with no computer yet. No plan can sign in there, so the AI step's lead
 * names the API key first.
 */
export function stepText(
  t: TFunction,
  step: StepId,
  {
    org,
    chosen,
    aiSaved,
    invited = 0,
    noComputer = false,
  }: { org: string; chosen: ReadonlySet<Preset>; aiSaved: boolean; invited?: number; noComputer?: boolean },
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
      return [
        t("onboarding.keyStep.title"),
        aiSaved
          ? t("connectAi.key.saved")
          : t(noComputer ? "onboarding.keyStep.leadNoComputer" : "onboarding.keyStep.lead"),
      ];
    case "team":
      return [t("onboarding.team.title")];
    case "done": {
      const names = PRESETS.filter((p) => chosen.has(p)).map((p) => t(`onboarding.presets.${p}.name`));
      const inGeneral =
        names.length === 0
          ? t("onboarding.done.textNone")
          : t(names.length === 1 ? "onboarding.done.inGeneralOne" : "onboarding.done.inGeneralMany", {
              names: joinNames(names, t("newAgent.and")),
            });
      // The invitations emailed on the team step, as the web's welcome says.
      const lead = invited > 0 ? `${inGeneral} ${t("onboarding.done.invited", { count: invited })}` : inGeneral;
      return [t("onboarding.done.title", { org }), lead];
    }
  }
}

/** An agent of the team once created: what Done's first message mentions and who it is from. */
export interface CrewMember {
  key: Preset;
  id: string;
  /** As the server made it: the first message mentions it. */
  handle: string;
  name: string;
}

/**
 * Done's first message, written for whoever is best placed to start (`firstAskOrder`: the phone sets up no
 * computer, so no browser is counted on): the asker and the text it offers. Null with nobody on the team.
 */
export function firstAskOf(t: TFunction, crew: readonly CrewMember[]): { asker: Preset; text: string } | null {
  const preset = firstAskOrder(false).find((p) => crew.some((c) => c.key === p));
  const asker = crew.find((c) => c.key === preset) ?? crew[0];
  if (!asker) return null;
  return {
    asker: asker.key,
    text: preset ? t(`onboarding.done.first.asks.${preset}`, { handle: asker.handle }) : "",
  };
}

/** Whether the agent the first message names can start on it now. */
export type AskState = AiStatus["agents"][number]["state"];
const LINE_ICON = { ready: "check", waiting: "clock", no_ai: "brain" } as const satisfies Record<AskState, string>;

/**
 * The line under the first message: the agent it names starts at once, waits for its computer, or has no AI yet;
 * with nobody named, only whether no agent has an AI. Null while there is nothing to say (or no text).
 */
export function askLineOf(
  t: TFunction,
  {
    text,
    mentioned,
    status,
    computer,
  }: {
    text: string;
    mentioned?: { id: string; name: string } | undefined;
    status: AiStatus | undefined;
    computer: string;
  },
): { state: AskState; icon: (typeof LINE_ICON)[AskState]; text: string } | null {
  if (text.trim() === "") return null;
  const state = mentioned ? aiStateOf(status, mentioned.id) : status?.any === false ? "no_ai" : undefined;
  if (!state) return null;
  const key = state === "no_ai" ? (mentioned ? "noAi" : "noAiAny") : state;
  const line = t(`onboarding.done.first.${key}`, { name: mentioned?.name, computer });
  return { state, icon: LINE_ICON[state], text: line };
}

/** A step that failed: what the server's code says (a refused workspace, a restriction), else that it didn't save. */
export const stepFailedText = (t: TFunction, error: unknown) => knownErrorText(t, error) ?? t("mobile.onb.failed");

/** Sends each invitation in turn; the addresses whose invitation failed, in order. */
export async function inviteEach(emails: string[], invite: (email: string) => Promise<unknown>): Promise<string[]> {
  const failed: string[] = [];
  for (const email of emails) await invite(email).catch(() => failed.push(email));
  return failed;
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
  return platformZoneName(zone, locale) ?? zoneCity(zone);
}
