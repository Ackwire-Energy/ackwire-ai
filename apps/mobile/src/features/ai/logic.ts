import type { AgentBrain, BrainKind, MachineAccount, MachineAccountKind, PlanUsage } from "@agenteschat/client";
import type { PlanGate } from "@agenteschat/client/lib/no-ai";

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
