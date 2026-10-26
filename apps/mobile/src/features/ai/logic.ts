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
