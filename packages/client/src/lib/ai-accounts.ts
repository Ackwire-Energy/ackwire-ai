import type { TFunction } from "i18next";
import type { AiAccounts, AiComputer, Machine, MachineAccount, MachineAccountKind, PlanUsage } from "../api/types";
import { loginPerAgent } from "./plans";

/** One account as a row shows it: its logins, one per agent where its plan allows it (`LOGIN_PER_AGENT`). */
export interface PlanAccount<A extends MachineAccount> {
  /** The first login's id. */
  key: string;
  /** Oldest first. They share the account's label, kind, plan and owner. */
  logins: A[];
  /** The agents that think with any of them. */
  usedBy: string[];
  /** The newest usage any of them reported: they share the plan's limits. */
  usage: PlanUsage | null;
  signedOut: A[];
}

const newest = (usages: (PlanUsage | null)[]) =>
  usages.reduce<PlanUsage | null>(
    (best, u) => (u && (!best || Date.parse(u.at) > Date.parse(best.at)) ? u : best),
    null,
  );

/**
 * The logins of one account together, as the server tells them apart: the same computer, owner, CLI and plan, and
 * the same email (any case) or key's last 4. Never the label, which any rename can repeat. A login whose email or
 * key the viewer can't see (another person's) is a row of its own.
 */
export function groupPlans<A extends MachineAccount & { machineId?: string }>(
  accounts: readonly A[],
): PlanAccount<A>[] {
  const groups = new Map<string, A[]>();
  for (const a of accounts) {
    const identity = a.provider ? a.keyHint : a.email?.toLowerCase();
    const key = identity ? JSON.stringify([a.machineId ?? null, a.ownerId, a.kind, a.provider, identity]) : a.id;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.values()].map((logins) => ({
    key: logins[0]?.id ?? "",
    logins,
    usedBy: logins.flatMap((l) => l.usedBy),
    usage: newest(logins.map((l) => l.usage)),
    signedOut: logins.filter((l) => l.status === "signed_out"),
  }));
}

/** One account in an agent's account choice: the login it offers, and the agents on any of its logins. */
export interface AccountChoice<A extends MachineAccount> {
  login: A;
  usedBy: string[];
  /**
   * Every login of it thinks for another agent, none for all of them (`shared`), and the account may have one per
   * agent (`LOGIN_PER_AGENT`): choosing it signs this agent in to it again ("Also used by Ada") instead of taking a
   * login from another agent.
   */
  also: boolean;
}

/**
 * An agent's account choice, one entry per account (`groupPlans`): the first of `ids` it has a login of (the one
 * chosen, then the one the agent thinks with), else a login of the viewer's that thinks for all of their agents
 * there or for nobody, else its first.
 */
export function accountChoices<A extends MachineAccount & { machineId?: string }>(
  accounts: readonly A[],
  ids: readonly (string | null | undefined)[],
): AccountChoice<A>[] {
  return groupPlans(accounts).flatMap(({ logins, usedBy }) => {
    const own =
      ids.map((id) => logins.find((l) => l.id === id)).find(Boolean) ??
      logins.find((l) => l.mine && (l.shared === true || l.usedBy.length === 0));
    const login = own ?? logins[0];
    if (!login) return [];
    return [{ login, usedBy, also: !own && login.mine && loginPerAgent(login.kind, login.provider) }];
  });
}

/**
 * "Use for…" an account that thinks for all of its owner's agents there (`shared`): the viewer's agents on its
 * computer that don't think with it yet. Never one on the workspace's API key: a plan makes an agent answer only
 * its owner, so that one moves on its own page.
 */
export function agentsToGive<A extends { id: string; ownerUserId: string | null }>({
  account,
  agents,
  machine,
  viewerId,
  onKey,
}: {
  account: Pick<MachineAccount, "shared" | "mine" | "usedByIds">;
  agents: readonly A[];
  /** The account's computer (`useMachines`): the agents on it. */
  machine: Pick<Machine, "agents"> | undefined;
  viewerId: string;
  /** The agent thinks with the workspace's API key now. */
  onKey: (agentId: string) => boolean;
}): A[] {
  if (account.shared !== true || !account.mine || !machine) return [];
  const here = new Set(machine.agents.map((a) => a.id));
  const using = new Set(account.usedByIds ?? []);
  return agents.filter((a) => here.has(a.id) && a.ownerUserId === viewerId && !using.has(a.id) && !onKey(a.id));
}

/**
 * Disconnecting ends the account's sign-in on the computer only: a Claude account made for all agents where each is
 * its own OS user is a token, which only Claude's settings revoke.
 */
export const endsOnClaude = (
  account: Pick<MachineAccount, "shared" | "kind" | "provider">,
  machine: Pick<Machine, "mode"> | undefined,
) => account.shared === true && account.kind === "claude_code" && !account.provider && machine?.mode === "system";

/** A computer's own sign-in as "Seus planos" lists it ("Conta deste computador"). */
export interface OwnSignInRow {
  key: string;
  machineId: string;
  computer: string;
  kind: MachineAccountKind;
  /** The plan the CLI reported (`max`, `pro`…), as it said it. */
  plan: string | null;
  usage: PlanUsage | null;
}

/** The viewer's computers' own sign-ins, Claude Code first on each computer (the computers' order kept). */
export function ownSignIns(view: Pick<AiAccounts, "computers"> | null | undefined): OwnSignInRow[] {
  const out: OwnSignInRow[] = [];
  for (const c of view?.computers ?? []) {
    for (const kind of ["claude_code", "codex"] as const) {
      const own = c.own?.[kind];
      if (!own) continue;
      out.push({
        key: `${c.machineId}:${kind}`,
        machineId: c.machineId,
        computer: c.name,
        kind,
        plan: own.plan ?? null,
        usage: own.usage ?? null,
      });
    }
  }
  return out;
}

/** The plan's name as people know it ("Max", "Pro"): the CLI's word with a capital, or nothing. */
export const planWordOf = (plan: string | null) =>
  plan ? plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase() : null;

/**
 * A computer's own sign-in by name: on a computer the viewer connected, the account their agents there share; on
 * someone else's, that computer's ("MacBook's account").
 */
export const ownSignInName = (t: TFunction, mine: boolean, computer: string) =>
  mine ? t("connectAi.own.shared") : t("agentPage.work.brain.thisComputer", { computer });

/**
 * The plan an agent's sign-in is on, as the CLI said it (`team`, `max`…): its account's, or with none (`account`
 * null) its computer's own sign-in's, from that computer's row of `GET …/ai-accounts`. A seat has its own words
 * under "Responde a todos".
 */
export function signInPlan(
  view: { account: string | null; accounts: readonly Pick<MachineAccount, "id" | "plan">[] },
  row: Pick<AiComputer, "own"> | undefined,
  kind: MachineAccountKind,
): string | null {
  if (view.account === null) return row?.own?.[kind]?.plan ?? null;
  return view.accounts.find((a) => a.id === view.account)?.plan ?? null;
}
