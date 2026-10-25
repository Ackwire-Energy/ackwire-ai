import type { Agent, AiStatus } from "../api/types";
import { aiStateOf, PLAN_BRAIN } from "./no-ai";

/**
 * An agent's action card (ADR 0061, `meta.actionCard`): its button opens the app's own dialog, filled in.
 * The card keeps no state; whether it's done comes from live data. Platform-neutral (web and phone).
 */

export type ConnectAiStep = "claude" | "chatgpt" | "api_key";

/** "Conectar uma IA": the Connect dialog at a step, for the agents the card names. */
export interface ConnectAiCard {
  kind: "connect_ai";
  /** Who the agent offered it to (the person behind its run). */
  forUserId: string | null;
  /** None: the dialog's first step (a plan or a key). */
  what?: ConnectAiStep;
  /** With `api_key`: the provider to pick. */
  provider?: string;
  /** None: any agent the person may change. */
  agentIds: string[];
  /** The agent's line for the person. */
  why: string;
}

const STEPS: ReadonlySet<string> = new Set<ConnectAiStep>(["claude", "chatgpt", "api_key"]);

export function actionCardOf(meta: Record<string, unknown> | null | undefined): ConnectAiCard | null {
  const raw = meta?.actionCard;
  if (!raw || typeof raw !== "object") return null;
  const card = raw as { kind?: unknown; forUserId?: unknown; params?: unknown };
  if (card.kind !== "connect_ai" || !card.params || typeof card.params !== "object") return null;
  const p = card.params as Record<string, unknown>;
  return {
    kind: "connect_ai",
    forUserId: typeof card.forUserId === "string" ? card.forUserId : null,
    ...(typeof p.what === "string" && STEPS.has(p.what) ? { what: p.what as ConnectAiStep } : {}),
    ...(typeof p.provider === "string" ? { provider: p.provider } : {}),
    agentIds: Array.isArray(p.agentIds) ? p.agentIds.filter((id): id is string => typeof id === "string") : [],
    why: typeof p.why === "string" ? p.why : "",
  };
}

/**
 * Done once every agent the card names can think, and for a plan's card thinks with that plan. A card that
 * names no agent (an organization's key) stays a button: nothing live says which key it was for.
 */
export function connectAiDone(
  card: ConnectAiCard,
  status: AiStatus | undefined,
  agentById: ReadonlyMap<string, Pick<Agent, "brain">>,
) {
  if (!status || card.agentIds.length === 0) return false;
  const brain = card.what === "claude" || card.what === "chatgpt" ? PLAN_BRAIN[card.what] : null;
  return card.agentIds.every(
    (id) => aiStateOf(status, id) === "ready" && (!brain || agentById.get(id)?.brain?.kind === brain),
  );
}
