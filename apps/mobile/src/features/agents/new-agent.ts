import { handleProblem, type RoleId } from "@agenteschat/client/lib/new-agent";

/**
 * "Criar agente" on the phone, the pure part: the web's steps that fit a thumb (where it works, its
 * model and budget start at the workspace's defaults and change on its page), and what keeps each one
 * from going on (the same rules as the web's `stepErrors`).
 */

export const NEW_AGENT_PHONE_STEPS = ["role", "identity", "instructions", "review"] as const;
export type PhoneStep = (typeof NEW_AGENT_PHONE_STEPS)[number];

export interface PhoneDraft {
  role: RoleId | null;
  name: string;
  handle: string;
  /** Handles already used, by agents or people. */
  taken: Set<string>;
}

/** Whether a step can't go on yet. */
export function stepBlocked(step: PhoneStep, d: PhoneDraft): boolean {
  if (step === "role") return !d.role;
  if (step === "identity") return !d.name.trim() || handleProblem(d.handle, d.taken) !== null;
  return false;
}

/** The first step that can't go on (-1 when it can be created). */
export const firstBlockedStep = (d: PhoneDraft) => NEW_AGENT_PHONE_STEPS.findIndex((s) => stepBlocked(s, d));
