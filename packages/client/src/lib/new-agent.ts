import type { AgentAudience } from "../api/types";
import { handleFrom, parseAmount } from "./text";

/**
 * "Criar agente" in steps: the pure part
 * (steps, roles, handle and budget rules, what each step needs). The role
 * presets, with their icon and look, live with each platform.
 */

export const NEW_AGENT_STEPS = ["role", "identity", "instructions", "tools", "where", "model", "review"] as const;
export type NewAgentStep = (typeof NEW_AGENT_STEPS)[number];

export const ROLE_IDS = [
  "dev",
  "ops",
  "qa",
  "pm",
  "support",
  "sales",
  "marketing",
  "content",
  "data",
  "finance",
  "people",
  "research",
  "assistant",
  "custom",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** The role step in groups, in order (titles in i18n: `newAgent.roleGroups.{id}`); "custom" stays apart, last. */
export const ROLE_GROUPS = [
  { id: "tech", roles: ["dev", "ops", "qa", "pm"] },
  { id: "customers", roles: ["support", "sales", "marketing", "content"] },
  { id: "operations", roles: ["data", "finance", "people", "research", "assistant"] },
] as const satisfies readonly { id: string; roles: readonly Exclude<RoleId, "custom">[] }[];
export type RoleGroupId = (typeof ROLE_GROUPS)[number]["id"];

/* ---------- @handle ---------- */

/** Same rule as the server (HANDLE_PATTERN in the engine): 2–32 of a-z, 0-9, - or _, not starting with - or _. */
export const AGENT_HANDLE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** What someone types in the @ field, kept to the allowed characters. */
export const cleanHandle = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);

/** The @ that follows the name while nobody edited it ("" for no name yet). */
export const handleForName = (name: string) => (name.trim() ? handleFrom(name) : "");

export type HandleProblem = "empty" | "format" | "taken";

/** Why a handle can't be used, if it can't: empty, the wrong shape, or someone's (agent or person) already. */
export function handleProblem(handle: string, taken: Set<string>): HandleProblem | null {
  if (!handle) return "empty";
  if (!AGENT_HANDLE.test(handle)) return "format";
  if (taken.has(handle)) return "taken";
  return null;
}

/** "ada" → "ada-2" (the first free one). */
export function freeHandle(handle: string, taken: Set<string>) {
  const base = handle.slice(0, 29).replace(/[-_]+$/, "") || "agente";
  for (let n = 2; n < 1000; n++) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
  return base;
}

/* ---------- Budget ---------- */

/** Quick amounts next to the budget field (US$ per month). */
export const QUICK_BUDGETS = [10, 30, 100] as const;

/** Empty = the workspace default (null); otherwise a positive amount, or invalid. */
export function readBudget(text: string): { amount: number | null; invalid: boolean } {
  if (text.trim() === "") return { amount: null, invalid: false };
  const amount = parseAmount(text);
  return { amount, invalid: !(amount > 0) };
}

/* ---------- What each step needs ---------- */

export interface DraftCheck {
  role: RoleId | null;
  name: string;
  handle: string;
  taken: Set<string>;
  ownerUserId: string | null;
  audience: AgentAudience;
  budget: string;
  /** The chosen model can be used (a key for its provider, or the platform key). */
  modelOk: boolean;
}

export type DraftError =
  | { field: "role"; code: "required" }
  | { field: "name"; code: "required" }
  | { field: "handle"; code: HandleProblem }
  | { field: "audience"; code: "noOwner" | "nobody" }
  | { field: "budget"; code: "invalid" }
  | { field: "model"; code: "unavailable" };

/** What keeps a step from going on (empty when it can). */
export function stepErrors(step: NewAgentStep, d: DraftCheck): DraftError[] {
  const out: DraftError[] = [];
  if (step === "role" && !d.role) out.push({ field: "role", code: "required" });
  if (step === "identity") {
    if (!d.name.trim()) out.push({ field: "name", code: "required" });
    const h = handleProblem(d.handle, d.taken);
    if (h) out.push({ field: "handle", code: h });
  }
  if (step === "where") {
    if (d.audience.mode === "owner" && !d.ownerUserId) out.push({ field: "audience", code: "noOwner" });
    if (d.audience.mode === "people" && d.audience.userIds.length === 0 && !d.ownerUserId)
      out.push({ field: "audience", code: "nobody" });
  }
  if (step === "model") {
    if (!d.modelOk) out.push({ field: "model", code: "unavailable" });
    if (readBudget(d.budget).invalid) out.push({ field: "budget", code: "invalid" });
  }
  return out;
}

/** The first step that can't go on yet (-1 when everything is ready). */
export const firstInvalidStep = (d: DraftCheck) => NEW_AGENT_STEPS.findIndex((s) => stepErrors(s, d).length > 0);
