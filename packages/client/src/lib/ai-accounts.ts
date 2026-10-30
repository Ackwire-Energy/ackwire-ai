import type { TFunction } from "i18next";
import type { AiAccounts, AiComputer, Credential, MachineAccount, MachineAccountKind, PlanUsage } from "../api/types";
import { joinNames } from "./format";
import { loginPerAgent, planName } from "./plans";

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
   * Every login of it thinks for another agent, and the account may have one per agent (`LOGIN_PER_AGENT`): choosing it
   * signs this agent in to it again ("Also used by Ada") instead of taking a login from another agent.
   */
  also: boolean;
}

/**
 * An agent's account choice, one entry per account (`groupPlans`): the first of `ids` it has a login of (the one
 * chosen, then the one the agent thinks with), else a login of the viewer's that thinks for nobody, else its first.
 */
export function accountChoices<A extends MachineAccount & { machineId?: string }>(
  accounts: readonly A[],
  ids: readonly (string | null | undefined)[],
): AccountChoice<A>[] {
  return groupPlans(accounts).flatMap(({ logins, usedBy }) => {
    const own =
      ids.map((id) => logins.find((l) => l.id === id)).find(Boolean) ??
      logins.find((l) => l.mine && l.usedBy.length === 0);
    const login = own ?? logins[0];
    if (!login) return [];
    return [{ login, usedBy, also: !own && login.mine && loginPerAgent(login.kind, login.provider) }];
  });
}

/** An account in an agent's account choice: its name, with its plan where the CLI said it ("Claude Team · Team"). */
export const accountTitle = (a: Pick<MachineAccount, "label" | "plan">) =>
  a.plan ? `${a.label} · ${planName(a.plan)}` : a.label;

/**
 * The line under an account in an agent's account choice (Quem pensa and Connect an AI, web and phone): whose it is
 * when it isn't the viewer's, the agents on it where choosing it signs this agent in to it too, signed out, the
 * agents it would be taken from, else its key's end or its email.
 */
export function accountAbout(
  t: TFunction,
  { login: a, usedBy, also }: AccountChoice<MachineAccount>,
  agentName: string,
): string | undefined {
  if (!a.mine) return t("agentPage.work.brain.accountOf", { name: a.ownerName?.split(" ")[0] ?? "" });
  if (also) return t("agentPage.work.brain.accountAlso", { agents: joinNames(usedBy, t("newAgent.and")) });
  if (a.status === "signed_out") return t("agentPage.work.brain.accountSignedOut");
  const others = a.usedBy.filter((n) => n !== agentName);
  if (others.length) return t("agentPage.work.brain.accountMove", { agents: others.join(", ") });
  return a.keyHint ? t("aiAccounts.page.keyEnds", { hint: a.keyHint }) : (a.email ?? undefined);
}

/**
 * What a row of what the person already has does for the agent: `use` it at once; `also` signs the agent in to that
 * account once more (one login per agent); `again` signs a free login of it back in; `move` takes it from the agent
 * on it; `locked`: someone else's, which only its owner picks (ADR 0041 §4, ADR 0059).
 */
export type ExistingAct = "use" | "also" | "again" | "move" | "locked";

export type ExistingAi<A extends MachineAccount = MachineAccount> =
  | { kind: "account"; choice: AccountChoice<A>; act: ExistingAct }
  | { kind: "key"; key: Credential };

const EXISTING_RANK: Record<ExistingAct | "key", number> = { use: 0, also: 1, again: 1, move: 1, key: 2, locked: 3 };

/** What an account's row does (`ExistingAct`); null for a signed-out login another agent thinks with. */
function existingAct({ login: a, also }: AccountChoice<MachineAccount>): ExistingAct | null {
  if (!a.mine) return "locked";
  if (also) return "also";
  const used = a.usedBy.length > 0;
  if (a.status === "signed_out") return used ? null : "again";
  return used ? "move" : "use";
}

/**
 * What a person already has for an agent with no AI (Connect an AI, before its new sign-ins): the accounts on the
 * agent's computer but the one it thinks with now, one row per account (`accountChoices`), the workspace's API keys
 * the person may use (`keys`: none for someone who may not), then someone else's accounts. The free ones first. A
 * signed-out login another agent thinks with stays out: it thinks for nobody until its owner signs it in again.
 */
export function existingAi<A extends MachineAccount>(
  view: { accounts: readonly A[]; account: string | null },
  keys: readonly Credential[],
): ExistingAi<A>[] {
  const accounts = accountChoices(
    view.accounts.filter((a) => a.id !== view.account),
    [],
  ).flatMap((choice): ExistingAi<A>[] => {
    const act = existingAct(choice);
    return act ? [{ kind: "account", choice, act }] : [];
  });
  const live = keys.filter((k) => !k.revokedAt).map((key): ExistingAi<A> => ({ kind: "key", key }));
  const rank = (r: ExistingAi<A>) => EXISTING_RANK[r.kind === "key" ? "key" : r.act];
  return [...accounts, ...live].sort((x, y) => rank(x) - rank(y));
}

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
