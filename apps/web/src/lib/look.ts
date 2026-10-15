import { type AgentAppearance, normalizeAppearance } from "@agenteschat/ui";

/** An agent's look for `<Avatar appearance>` (unknown values fall back to the default). */
export const lookOf = (agent: { appearance?: unknown } | undefined | null): AgentAppearance | undefined =>
  agent?.appearance ? normalizeAppearance(agent.appearance) : undefined;
