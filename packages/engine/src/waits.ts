import type { PubSub } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import type { Judge } from "./judge";
import type { Message } from "./messages";
import type { AgentRun } from "./runs";

/** What a person's message did to the wait of the run it reached (`agent.run.wait_message`). */
export interface WaitMessageOutcome {
  /** `browser_handoff`, `consultation`, `approval`, `question`, `secret`, `mission`… */
  waitKind: string;
  outcome: "resolved" | "woke" | "held";
}

/**
 * A person's message reached a run that waits (not for its computer). Decides
 * whether it ends the wait, wakes the run, or is held for a decision on a card.
 * Null: nothing to do (the message stays queued, read when the run resumes).
 */
export async function onMessageWhileWaiting(
  _deps: { db: Database; pubsub: PubSub; judge?: Judge },
  _run: AgentRun,
  _message: Message,
): Promise<WaitMessageOutcome | null> {
  return null;
}
