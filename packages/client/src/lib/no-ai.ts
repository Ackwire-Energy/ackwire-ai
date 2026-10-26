import type { TFunction } from "i18next";
import type {
  AgentBrain,
  AiComputer,
  AiStatus,
  BrainUnavailable,
  ConnectIntent,
  Edition,
  MachineAccountKind,
} from "../api/types";
import { type SetupView, setupPending } from "./computer";
import { CODING_PLANS, isPlanId, PLAN_IDS, type PlanId } from "./plans";

/**
 * No AI connected (ADR 0061): an agent's card when it can't answer, and the Connect step a person who
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

/** A plan a person signs in with, on the agent's computer: Claude's, ChatGPT's, or a coding plan's key. */
export type PlanChoice = "claude" | "chatgpt" | PlanId;
/** What the picker offers: a plan, or the workspace's API key. */
export type AiChoice = PlanChoice | "key";
/** Every picker's order: Claude (chosen first), ChatGPT, then the coding plans. */
export const PLAN_CHOICES: readonly PlanChoice[] = ["claude", "chatgpt", ...PLAN_IDS];
/** The account a plan signs in as: ChatGPT's through Codex; Claude's and every coding plan's through Claude Code. */
export const kindOf = (choice: PlanChoice): MachineAccountKind =>
  choice === "chatgpt" ? PLAN_BRAIN.chatgpt : PLAN_BRAIN.claude;
/** A plan's maker mark (a `ProviderLogo` id): ChatGPT's is OpenAI's. */
export const planMark = (choice: PlanChoice) => (choice === "chatgpt" ? "openai" : choice);
/** A plan's short name, as its tile and its accounts say it: "Claude", "ChatGPT", "GLM Coding"… */
export const planLabel = (t: TFunction, choice: PlanChoice) =>
  isPlanId(choice) ? CODING_PLANS[choice].label : t(`aiAccounts.connect.${kindOf(choice)}`);
/** A plan's name in its panel, as its maker sells it: "Your Claude plan", "GLM Coding Plan"… */
export const planTitle = (t: TFunction, choice: PlanChoice) =>
  isPlanId(choice) ? CODING_PLANS[choice].name : t(`connectAi.plan.${choice}.title`);
/** The marks overlapped on the computer's plan line, and on the API key row. */
export const PLAN_MARKS = ["claude", "openai", "zai", "kimi"] as const;
export const KEY_MARKS = ["claude", "openai", "deepseek", "kimi"] as const;

/** What a plan's panel can do now for one agent: sign in, or why not yet. */
export type PlanGate =
  | { state: "loading" }
  /** The Cloud's computer on its way; `view` null: it said ready and the agent gets it on the next refresh. */
  | { state: "preparing"; view: SetupView | null }
  | { state: "offline" }
  /** Self-host with no computer for the agent (none connected, or a Daytona sandbox). */
  | { state: "missing" }
  | { state: "unsupported"; reason: BrainUnavailable | "keys" }
  /** `owner`: the viewer doesn't own the agent; `computer`: only whoever connected it adds a sign-in there. */
  | { state: "locked"; who: "owner" | "computer" }
  | { state: "ready" };

/**
 * The gate, first match wins. `brain` is the chosen agent's view (undefined while it loads); `computer` is that
 * computer's `/ai-accounts` row, which says whether it takes a coding plan's key.
 */
export function planGate({
  choice,
  edition,
  setup,
  brain,
  computer,
}: {
  choice: PlanChoice;
  edition: Edition | null;
  setup: SetupView | null;
  brain: AgentBrain | undefined;
  computer: AiComputer | undefined;
}): PlanGate {
  if (edition === "cloud" && setupPending(setup)) return { state: "preparing", view: setup };
  if (!brain || !edition) return { state: "loading" };
  if (!brain.canUsePlans) return { state: "locked", who: "owner" };
  if (!brain.computer) return edition === "cloud" ? { state: "preparing", view: null } : { state: "missing" };
  if (!brain.computer.online) return { state: "offline" };
  const option = brain.options.find((o) => o.kind === kindOf(choice));
  if (!option?.available) return { state: "unsupported", reason: option?.reason ?? "not_installed" };
  if (!brain.accountsSupported) return { state: "unsupported", reason: "runner_old" };
  if (isPlanId(choice) && !computer?.keys) return { state: "unsupported", reason: "keys" };
  if (!brain.canManageAccounts) return { state: "locked", who: "computer" };
  return { state: "ready" };
}

/** A plan tile reads dimmed when its plan can't sign in there at all (it still opens its panel, which says why). */
export const gateDims = (gate: PlanGate) => gate.state === "missing" || gate.state === "unsupported";

/** The option a message asked for (Jev, a card); null for `any` and `task`. */
export const choiceOfIntent = (intent: ConnectIntent | undefined): AiChoice | null =>
  intent === "claude" || intent === "chatgpt" ? intent : intent === "api_key" ? "key" : null;

/**
 * The option chosen when the picker opens: what was asked for; the API key for someone who owns no agent but may
 * add keys, or where Claude can't sign in at all (self-host with no computer); else Claude.
 */
export function defaultChoice({
  intent,
  ownsAgents,
  mayAddKey,
  claudeGate,
}: {
  intent?: ConnectIntent;
  ownsAgents: boolean;
  mayAddKey: boolean;
  claudeGate: PlanGate;
}): AiChoice {
  const asked = choiceOfIntent(intent);
  if (asked) return asked;
  if (!ownsAgents && mayAddKey) return "key";
  return claudeGate.state === "missing" ? "key" : "claude";
}

/** "For which agent": the one asked for, else the first with no AI, else the first. */
export const firstAgent = <A extends { id: string }>(
  agents: readonly A[],
  hasAi: (id: string) => boolean,
  asked?: string,
) => agents.find((a) => a.id === asked) ?? agents.find((a) => !hasAi(a.id)) ?? agents[0];
