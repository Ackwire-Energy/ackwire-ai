import type { AiStatus, ConnectIntent, MachineAccountKind } from "../api/types";

/**
 * No AI connected (ADR 0057): an agent's card when it can't answer, and the Connect step a person who
 * met it asked for. Platform-neutral (web and phone).
 */

/** A failed run's error, a routing decision's and a receipt's reason: nobody had an AI to think with. */
export const NO_AI = "no_ai";

/** `meta.noAi` of an agent's card (`bodyCode: "no_ai"`). */
export interface NoAiCard {
  agentId: string;
  /** Who asked: the Connect dialog may open by itself for them only. */
  forUserId: string | null;
  intent: ConnectIntent;
  /** With `api_key`: the provider the message named. */
  provider?: string;
  autoOpen?: boolean;
}

const INTENTS: ReadonlySet<string> = new Set<ConnectIntent>(["claude", "chatgpt", "api_key", "any", "task"]);
const isIntent = (v: unknown): v is ConnectIntent => typeof v === "string" && INTENTS.has(v);

export function noAiCardOf(meta: Record<string, unknown> | null | undefined): NoAiCard | null {
  const raw = meta?.noAi;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.agentId !== "string") return null;
  return {
    agentId: o.agentId,
    forUserId: typeof o.forUserId === "string" ? o.forUserId : null,
    intent: isIntent(o.intent) ? o.intent : "task",
    ...(typeof o.provider === "string" ? { provider: o.provider } : {}),
    ...(o.autoOpen === true ? { autoOpen: true } : {}),
  };
}

/**
 * The dialog opens by itself only where the server marked it (Jev at 0.9 or more) and at a step: never
 * for `any` or `task`, where a guess opened dialogs nobody asked for.
 */
export const opensByItself = (x: { intent?: string; autoOpen?: boolean }) =>
  x.autoOpen === true && (x.intent === "claude" || x.intent === "chatgpt" || x.intent === "api_key");

/** The brain a plan thinks with, on the agent's computer: a Claude plan through Claude Code, ChatGPT's through Codex. */
export const PLAN_BRAIN: Record<"claude" | "chatgpt", MachineAccountKind> = { claude: "claude_code", chatgpt: "codex" };

/** An agent's state in the AI status; undefined while it loads or for an agent it doesn't list. */
export const aiStateOf = (status: AiStatus | undefined, agentId: string) =>
  status?.agents.find((a) => a.agentId === agentId)?.state;
