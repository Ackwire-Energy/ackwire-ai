import type {
  AgentBrain,
  AgentBrainInput,
  BrainKind,
  Credential,
  MachineAccount,
  MachineAccountKind,
  PlanUsage,
} from "@agenteschat/client";
import { autonomyWords, type NewAgentStart } from "@agenteschat/client/lib/agent-setup";
import {
  type AccountChoice,
  accountAbout,
  accountTitle,
  type ExistingAi,
  existingAi,
} from "@agenteschat/client/lib/ai-accounts";
import { thinksWith } from "@agenteschat/client/lib/brain";
import { type Advanced, advancedParts, isClaudeAlias } from "@agenteschat/client/lib/brain-advanced";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiChoiceOf, type PlanGate, planOfAccount } from "@agenteschat/client/lib/no-ai";
import {
  brainModelChoice,
  brainModelChoices,
  brainPlan,
  type CodingPlan,
  type PlanModelNeed,
} from "@agenteschat/client/lib/plans";
import { AUTO, isAuto, providerLabel } from "@agenteschat/client/lib/providers";
import type { TFunction } from "i18next";

/*
 * What only the phone's "Conectar uma IA" decides. Pure, so it is unit-tested.
 */

/**
 * "Usar uma chave de API agora" under a plan that can't sign in on the agent's computer yet. On the phone the key's
 * row is a page away, so every wait for the workspace's computer offers it (not on hold: nothing runs then), as do
 * an offline computer, none and one that can't take the plan.
 */
export const offersKeyNow = (gate: PlanGate, held: boolean) =>
  gate.state === "preparing"
    ? gate.view !== null && !held
    : gate.state === "offline" || gate.state === "missing" || gate.state === "unsupported";

/** How often a plan's page asks again while it waits (the web's first run asks as often). */
export const PLAN_POLL_MS = 5000;

/**
 * Whether the plan shown waits on something no event may bring (the first run opens no socket): the workspace's
 * computer on its way, the agent's computer offline, or the views not in yet. Ready, missing, unsupported or
 * locked stay put until the person does something.
 */
export const pollsPlan = (state: PlanGate["state"]) =>
  state === "preparing" || state === "offline" || state === "loading";

/* The agent's AI on the phone (the web's "Quem pensa", ADR 0059): what its page lists and reads. */

/** The kind of account a plan brain thinks with; null on the API. */
export const accountKindOf = (brain: BrainKind | undefined): MachineAccountKind | null =>
  brain === "claude_code" || brain === "codex" ? brain : null;

/**
 * The accounts the agent's page lists, as the web's picker: the viewer's own of that kind (each person picks among
 * theirs), and someone else's only while it is this agent's.
 */
export const agentAccounts = (view: Pick<AgentBrain, "accounts" | "account">, kind: MachineAccountKind) =>
  view.accounts.filter((a) => a.kind === kind && (a.mine || a.id === view.account));

/** The plan usage of what it thinks with: its account's, or the computer's own sign-in's where that thinks for it. */
export function thinkingUsage(
  view: Pick<AgentBrain, "accounts" | "account" | "ownSignIn" | "ownUsage">,
  kind: MachineAccountKind,
): PlanUsage | undefined {
  if (view.account === null) return view.ownSignIn ? view.ownUsage[kind] : undefined;
  return view.accounts.find((a) => a.id === view.account)?.usage ?? undefined;
}

/**
 * The other agents an account thinks for now: picking it takes it from them ("Mover para cá"). One made for all of
 * its owner's agents there (`shared`) takes it from nobody: they think with it too ("Também usada por").
 */
export const takenFrom = (account: Pick<MachineAccount, "usedBy" | "shared">, agentName: string) =>
  account.shared === true ? [] : account.usedBy.filter((n) => n !== agentName);

/** A row of the agent's model page. */
export interface ModelRow {
  value: string;
  label: string;
  /** What it does or is sold as. */
  sub?: string;
  /** What the plan's account must allow before it answers, behind the row's ⓘ. */
  note?: string;
  /** That need's id: chosen, the agent's page says how to give it (`brain.modelHow`). */
  needs?: PlanModelNeed;
  /** Who makes it, on a plan of several makers' models: a provider's id or the maker's name. */
  maker?: string;
  checked: boolean;
}

/**
 * The agent's model on the phone, as the web's "Quem pensa": Automático, then its brain's models (every model of
 * its account's coding plan, each with what its maker sells it as; Claude's own with what each is for), the one it
 * runs checked.
 */
export function modelRows(
  t: TFunction,
  view: Pick<AgentBrain, "brain" | "effectiveModel" | "options">,
  plan: CodingPlan | undefined,
): ModelRow[] {
  const option = view.options.find((o) => o.kind === view.brain);
  const chosen = brainModelChoice(view.brain, plan, view.effectiveModel ?? option?.defaultModel ?? "");
  const rows: Omit<ModelRow, "checked">[] = [
    { value: AUTO, label: t("brain.auto.label"), sub: t("brain.auto.hint") },
    ...brainModelChoices(plan, option?.models ?? []).map(({ value, label, tag, needs, maker }) => ({
      value,
      label,
      // Claude's own models say what each is for.
      ...(tag
        ? { sub: t(`brain.modelTag.${tag}`) }
        : !plan && view.brain === "claude_code" && isClaudeAlias(value)
          ? { sub: t(`agentPage.work.brain.modelLine.${value}`) }
          : {}),
      ...(needs ? { note: t(`brain.modelNeeds.${needs}`), needs } : {}),
      ...(maker ? { maker } : {}),
    })),
  ];
  return rows.map((r) => ({ ...r, checked: r.value === chosen }));
}

/** The model page's lists: one, or on a plan of several makers' models Automático's and one per maker. */
export function modelSections(rows: ModelRow[]): { maker?: string; rows: ModelRow[] }[] {
  const sections: { maker?: string; rows: ModelRow[] }[] = [];
  for (const r of rows) {
    const last = sections.at(-1);
    if (last && last.maker === r.maker) last.rows.push(r);
    else sections.push({ ...(r.maker ? { maker: r.maker } : {}), rows: [r] });
  }
  return sections;
}

/**
 * What picking an account saves on the agent's page (null: the computer's own sign-in), where the account list is the
 * plan choice: the account, and on another plan that plan's default model (its models aren't this one's), Automático
 * staying Automático, as the web's cards do.
 */
export function accountInput(
  view: Pick<AgentBrain, "brain" | "account" | "accounts" | "effectiveModel">,
  a: Pick<MachineAccount, "id" | "kind" | "provider"> | null,
): Pick<AgentBrainInput, "account" | "model"> {
  const kind = accountKindOf(view.brain);
  const next = a ? planOfAccount(a) : kind ? planOfAccount({ kind, provider: null }) : null;
  if (next === aiChoiceOf(view)) return { account: a?.id ?? null };
  return { account: a?.id ?? null, model: isAuto(view.effectiveModel) ? AUTO : null };
}

type ThinkingView = Pick<AgentBrain, "brain" | "effectiveModel" | "options" | "accounts" | "account">;

/** What thinks, in the one sentence every place says it: the model by the plan that pays for it, or the API's model. */
function thinksNow(t: TFunction, view: ThinkingView): string | undefined {
  const model = modelRows(t, view, brainPlan(view)).find((r) => r.checked)?.label;
  const ai = aiChoiceOf(view);
  return ai === "key" || !model ? model : thinksWith(t, ai, model);
}

/**
 * What the agent's page says once an account is saved (`saved`: the view the save returned): the account it now uses
 * (the computer's own sign-in as the account its owner's agents share), or, when the account was another plan's, what
 * thinks now, since its model changed with it (`accountInput`), as the web's cards say it.
 */
export function accountSaved(
  t: TFunction,
  language: string,
  agentName: string,
  a: Pick<MachineAccount, "label"> | null,
  input: Pick<AgentBrainInput, "model">,
  saved: ThinkingView,
): string {
  const g = agentGrammar(agentName);
  if ("model" in input) return t("agentPage.work.saved.brain", { ...g, brain: thinksNow(t, saved) ?? "" });
  return a
    ? t("agentPage.work.saved.account", { ...g, account: a.label })
    : t("aiAccounts.done.savedAgent", { agent: agentName, label: lowerFirst(t("connectAi.own.shared"), language) });
}

/** What picking a model saves, as the web's dialog does: Automático picks the effort too; a fixed one after it, Médio. */
export function modelInput(
  value: string,
  view: Pick<AgentBrain, "effort" | "options" | "brain">,
): Pick<AgentBrainInput, "model" | "effort"> {
  if (isAuto(value)) return { model: AUTO, effort: AUTO };
  const defaultModel = view.options.find((o) => o.kind === view.brain)?.defaultModel;
  return { model: value === defaultModel ? null : value, ...(isAuto(view.effort) ? { effort: "medium" } : {}) };
}

/** An account as the agent's AI lists it (its page and Connect an AI): its name and plan, the line under it, its mark. */
export const accountRow = (t: TFunction, choice: AccountChoice<MachineAccount>, agentName: string) => ({
  label: accountTitle(choice.login),
  sub: accountAbout(t, choice, agentName),
  mark: choice.login.provider ?? choice.login.kind,
  off: choice.login.status === "signed_out",
});

/**
 * Connect an AI's first group: what the person already has for the agent (`existingAi`), each row as it reads, the
 * accounts as the agent's page lists them and a workspace key with the budget line under it.
 */
export function existingRows(
  t: TFunction,
  view: Pick<AgentBrain, "accounts" | "account">,
  keys: readonly Credential[],
  agentName: string,
) {
  return existingAi(view, keys).map((row: ExistingAi) =>
    row.kind === "key"
      ? {
          key: row.key.id,
          row,
          label: row.key.label,
          sub: t("newAgent.otherKeyDesc", { provider: providerLabel(row.key.provider), hint: row.key.keyHint }),
          below: t("agentPage.work.brain.modelText", agentGrammar(agentName)),
          mark: row.key.provider,
          off: false,
        }
      : { key: row.choice.login.id, row, ...accountRow(t, row.choice, agentName) },
  );
}

/**
 * "Usar em outros agentes" on the phone (ADR 0094): the agent's saved setup in words, as the web's dialog says it
 * ("Opus pelo plano do Claude · Esforço alto · Autonomia: Não pergunta"): the model by the plan that pays for it (the
 * API's model alone), what differs in its advanced settings and its Autonomia.
 */
export function setupWords(
  t: TFunction,
  language: string,
  view: Pick<AgentBrain, "brain" | "effectiveModel" | "options" | "accounts" | "account" | "autonomy">,
  o: { apiKey: boolean; now: Advanced },
): string {
  const parts = advancedParts(t, language, {
    kind: view.brain,
    autoModel: isAuto(view.effectiveModel),
    apiKey: o.apiKey,
    now: o.now,
  });
  const autonomy = view.autonomy ? autonomyWords(t, view.autonomy) : null;
  return [thinksNow(t, view), ...parts, autonomy].filter(Boolean).join(" · ");
}

/**
 * What the phone's Criar agente sends for who thinks (ADR 0094): the last setup's API model and key at creation, and
 * its context window right after; or Automático there and the last setup's plan saved on it right after; with no
 * setup, Automático on the API. The setup's Autonomia goes at creation either way.
 */
export function newAgentAi(thinks: NewAgentStart | null) {
  const autonomy = thinks?.autonomy;
  if (thinks?.brain === "model") {
    return { model: thinks.model, credentialId: thinks.key, contextTokens: thinks.contextTokens, plan: null, autonomy };
  }
  return {
    model: AUTO,
    credentialId: null,
    contextTokens: null,
    plan: thinks ? { machineId: thinks.machineId, input: thinks.input } : null,
    autonomy,
  };
}
