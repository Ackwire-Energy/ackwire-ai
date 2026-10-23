import type { PubSub } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import type { AgentRun } from "./runs";

/**
 * A background run (`agent_runs.background`, a routine's run) reached its
 * final answer: nothing is posted in the conversation. Its text is the run's
 * own record (the routine's history); people hear only what it handed off.
 */
export async function finishBackgroundRun(
  _deps: { db: Database; pubsub: PubSub },
  _run: AgentRun,
  _text: string,
): Promise<void> {}
