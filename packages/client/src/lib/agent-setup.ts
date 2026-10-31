import type { TFunction } from "i18next";
import type { AgentBrain, AgentBrainInput, AgentSetup, AgentSetupResult, NewAgentSetup } from "../api/types";

/*
 * One agent's "Quem pensa" on others (ADR 0089), the same on the web (a dialog over "Quem pensa") and the phone (a
 * screen from "Pensa com"), and the setup a new agent starts with. The server decides what each agent takes.
 */

/** The setup an agent's saved "Quem pensa" says, for a computer brain (the phone's "Pensa com"). */
export function setupOfBrain(view: AgentBrain): AgentSetup | null {
  if (view.brain === "model" || !view.computer) return null;
  return {
    brain: view.brain,
    machineId: view.computer.machineId,
    account: view.account,
    model: view.model,
    effort: view.effort,
    contextTokens: view.contextTokens,
    fallback: view.fallback,
    onlyOwner: view.onlyOwner,
  };
}

const ORDER = { applied: 0, same: 1, skipped: 2 } as const;

/** Who can take it first, then who already thinks so, then who can't; each group in the order asked. */
export const sortedResults = (results: readonly AgentSetupResult[]) =>
  [...results].sort((a, b) => ORDER[a.status] - ORDER[b.status]);

/** The agents "Todos" picks: those that can take it. */
export const takers = (results: readonly AgentSetupResult[]) =>
  results.filter((r) => r.status === "applied").map((r) => r.agentId);

/**
 * The line under an agent: what it thinks with now (`now`), what it keeps, that it already thinks so, or why it
 * can't take it (`owner`: the agent's owner's first name, for who else may change it).
 */
export function setupResultLine(
  t: TFunction,
  r: AgentSetupResult,
  o: { now: string; owner?: string | null | undefined },
): string {
  const p = r.params ?? {};
  if (r.status === "same") return t("agentPage.work.brain.copy.same");
  if (r.status === "applied") {
    if (!r.keeps) return t("agentPage.work.brain.copy.now", { brain: o.now });
    return r.keeps.account
      ? t("agentPage.work.brain.copy.keeps", { account: r.keeps.account })
      : t("agentPage.work.brain.copy.keepsOwn");
  }
  switch (r.reason) {
    case "not_allowed":
      return o.owner
        ? t("agentPage.work.brain.copy.reasons.not_allowed", { owner: o.owner })
        : t("agentPage.work.brain.copy.reasons.not_allowedNobody");
    case "admins_only":
      return t("agentPage.work.brain.copy.reasons.admins_only");
    case "account_owner":
      return p.owner
        ? t("agentPage.work.brain.copy.reasons.account_ownerOf", { owner: firstName(p.owner) })
        : t("agentPage.work.brain.copy.reasons.account_owner");
    case "account_single":
      return t("agentPage.work.brain.copy.reasons.account_single", { agent: p.agent ?? "" });
    case "other_computer":
      return p.computer
        ? t("agentPage.work.brain.copy.reasons.other_computer", { computer: p.computer })
        : t("agentPage.work.brain.copy.reasons.other_computerNone");
    case "model_missing":
      return t("agentPage.work.brain.copy.reasons.model_missing", { plan: p.plan ?? "", model: p.model ?? "" });
    default:
      return t("agentPage.work.brain.copy.reasons.failed");
  }
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/** What "Criar agente" starts on: the API's model and key, or a plan on a computer, with what to save on it after. */
export type NewAgentStart =
  | { brain: "model"; model: string; key: string | null }
  | {
      brain: "claude_code" | "codex";
      machineId: string;
      computer: string;
      account: { id: string; label: string } | null;
      /** Saved as its "Quem pensa" once the agent exists. */
      input: AgentBrainInput;
    };

/**
 * The setup a new agent starts with (ADR 0089), where it can think for it: the API's always (its model still has
 * to be usable), a plan only for an agent of the person's own, on their account with room for one more agent or on
 * a computer they connected (its own sign-in). Null: "Automático" on the API, as before.
 */
export function newAgentStart(s: NewAgentSetup | null | undefined, ownerIsMe: boolean): NewAgentStart | null {
  if (!s) return null;
  if (s.brain === "model") return s.model ? { brain: "model", model: s.model, key: s.key } : null;
  if (!ownerIsMe || !s.computer) return null;
  if (s.account ? !(s.account.mine && s.account.free) : !s.ownSignIn) return null;
  return {
    brain: s.brain,
    machineId: s.computer.machineId,
    computer: s.computer.name,
    account: s.account ? { id: s.account.id, label: s.account.label } : null,
    input: {
      brain: s.brain,
      account: s.account?.id ?? null,
      model: s.model,
      effort: s.effort ?? null,
      contextTokens: s.contextTokens,
      fallback: s.fallback ?? true,
    },
  };
}
