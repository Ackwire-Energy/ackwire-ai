import type {
  AgentBrain,
  BrainKind,
  Credential,
  MachineAccount,
  MachineAccountKind,
  PlanUsage,
} from "@agenteschat/client";
import {
  type AccountChoice,
  accountAbout,
  accountTitle,
  type ExistingAi,
  existingAi,
} from "@agenteschat/client/lib/ai-accounts";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import type { PlanGate } from "@agenteschat/client/lib/no-ai";
import { providerLabel } from "@agenteschat/client/lib/providers";
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

/** The other agents an account thinks for now: picking it takes it from them ("Mover para cá"). */
export const takenFrom = (account: Pick<MachineAccount, "usedBy">, agentName: string) =>
  account.usedBy.filter((n) => n !== agentName);

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
          below: t("agentPage.work.brain.modelText", agentGrammar(t, agentName)),
          mark: row.key.provider,
          off: false,
        }
      : { key: row.choice.login.id, row, ...accountRow(t, row.choice, agentName) },
  );
}
