import type { PubSub } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import type { AgentRun } from "./runs";

/**
 * Live delivery to a computer brain mid-turn (Claude Code reads a message at
 * its next tool boundary). Returns true when the message was handed to the
 * turn in progress (its read is confirmed later, `agent.run.read`); false
 * leaves it for the run's next step, as before.
 */
export async function deliverLive(
  _deps: { db: Database; pubsub: PubSub },
  _run: AgentRun,
  _input: { messageId: string; urgent: boolean },
): Promise<boolean> {
  return false;
}
