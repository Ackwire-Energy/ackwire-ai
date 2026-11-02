import type { TFunction } from "i18next";
import { usageWhen } from "./plan-usage";

/**
 * Long work paused near a plan's or a budget's limit (ADR 0118, `meta.actionCard` `usage_paused`): it picks up by
 * itself when the limit resets, and Continuar agora (`api.chat.answerNow` on the card) lets it go on now. Shared by
 * the web and the phone.
 */
export interface UsagePauseCard {
  kind: "usage_paused";
  state: "paused" | "continued" | "resumed" | "ended" | "canceled";
  /** The paused run: "Don't run it" cancels it. */
  runId: string | null;
  agentId: string;
  /** The person behind the work: with the agent's owner and admins, who may press Continuar agora. */
  forUserId: string | null;
  source: "plan" | "budget";
  percent: number;
  window: string | null;
  plan: string;
  resetsAt: string | null;
  continuedByUserId: string | null;
  continuedAt: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function usagePauseCardOf(meta: Record<string, unknown> | null | undefined): UsagePauseCard | null {
  const raw = meta?.actionCard as Record<string, unknown> | undefined;
  if (raw?.kind !== "usage_paused" || typeof raw.agentId !== "string" || typeof raw.percent !== "number") return null;
  return {
    kind: "usage_paused",
    state:
      raw.state === "continued" || raw.state === "resumed" || raw.state === "ended" || raw.state === "canceled"
        ? raw.state
        : "paused",
    runId: str(raw.runId),
    agentId: raw.agentId,
    forUserId: str(raw.forUserId),
    source: raw.source === "budget" ? "budget" : "plan",
    percent: raw.percent,
    window: str(raw.window),
    plan: str(raw.plan) ?? "",
    resetsAt: str(raw.resetsAt),
    continuedByUserId: str(raw.continuedByUserId),
    continuedAt: str(raw.continuedAt),
  };
}

/** "das 5 horas", "of its week": a plan's window as the card says it. */
export const usageWindowText = (t: TFunction, window: string) =>
  (t as unknown as (key: string, o: Record<string, unknown>) => string)(`usageCard.window.${window}`, {
    defaultValue: "",
  });

/** The card's title and its line ("Ada pausou este trabalho · plano do Claude em 96% das 5 horas", "Retoma às 15:40…"). */
export function usagePauseText(t: TFunction, locale: string, card: UsagePauseCard, agent: string) {
  const say = t as unknown as (key: string, o: Record<string, unknown>) => string;
  const title =
    card.source === "budget"
      ? say("chat.body.usage_paused_budget", { agent, percent: card.percent })
      : say("chat.body.usage_paused", {
          agent,
          plan: card.plan,
          percent: card.percent,
          window: card.window ? usageWindowText(t, card.window) : "",
        }).trim();
  const when = card.resetsAt ? usageWhen(t, locale, card.resetsAt) : null;
  const line =
    card.source === "budget"
      ? say("usageCard.lineBudget", { when: when ?? "" })
      : when
        ? say("usageCard.line", { when })
        : say("usageCard.lineUnknown", {});
  return { title, line };
}

/**
 * Continuar agora and "Don't run it" are for the person behind the work, the agent's owner or an admin (the server's
 * `mayStopRun`); everyone else sees them greyed.
 */
export const mayContinueUsage = (
  card: Pick<UsagePauseCard, "forUserId">,
  meId: string | null,
  ownerId: string | null | undefined,
  admin: boolean,
) => admin || (meId !== null && (card.forUserId === meId || ownerId === meId));

export interface UsageWait {
  runId: string;
  forUserId: string | null;
  canceled: boolean;
  /** Its run is back at work, or over: nothing waits to cancel. */
  ended: boolean;
}

/**
 * An agent's note that it waits on its plan or budget (`meta.usageWait`: "I'll answer at 9:00"), with the run it holds:
 * "Don't run it" cancels that run. Null: no such note, or one written before notes named their run.
 */
export function usageWaitOf(meta: Record<string, unknown> | null | undefined): UsageWait | null {
  const raw = meta?.usageWait as Record<string, unknown> | undefined;
  const runId = str(raw?.runId);
  if (!runId || usagePauseCardOf(meta)) return null;
  return { runId, forUserId: str(raw?.forUserId), canceled: raw?.canceled === true, ended: raw?.ended === true };
}
