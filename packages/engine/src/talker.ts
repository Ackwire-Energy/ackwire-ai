import type { Message } from "./messages";
import type { AgentRun } from "./runs";
import type { WaitMessageOutcome } from "./waits";

export interface TalkerInput {
  /** The run the message went into (as it was when the message landed). */
  run: AgentRun;
  message: Message;
  /** Handed to the computer brain mid-turn (it reads it at its next tool boundary). */
  live: boolean;
  /** What the message did to the run's wait, if it waited. */
  waited: WaitMessageOutcome | null;
}

/**
 * The agent's conversation layer: while its task works or waits, it may
 * answer a person in a second or two, as the agent, from what the task is
 * doing (or pass). Never runs tools, never grants anything.
 */
export interface Talker {
  consider(input: TalkerInput): Promise<void>;
}
