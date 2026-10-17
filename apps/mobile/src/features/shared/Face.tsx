import { AgentAvatar, PersonAvatar } from "@/ui";
import { useDirectory } from "./hooks";
import { agentLook } from "./logic";

/**
 * A person's or an agent's face. Agents are living bodies; long lists pass
 * `live={false}` (a still frame).
 */
export function Face({
  who,
  size,
  mode = "idle",
  live = true,
}: {
  who: { type: string; id: string | null } | null | undefined;
  size: number;
  mode?: "idle" | "run" | "think" | "rest";
  live?: boolean;
}) {
  const dir = useDirectory();
  if (who?.type === "agent") {
    const agent = who.id ? dir.agentById.get(who.id) : undefined;
    return <AgentAvatar agent={agentLook(agent)} size={size} mode={mode} live={live} />;
  }
  return <PersonAvatar name={dir.nameOf(who) || "?"} size={size} />;
}

/** An agent by id (its look from the directory). */
export function AgentFace({
  agentId,
  size,
  mode = "idle",
  live = true,
}: {
  agentId: string | null | undefined;
  size: number;
  mode?: "idle" | "run" | "think" | "rest";
  live?: boolean;
}) {
  const dir = useDirectory();
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  return <AgentAvatar agent={agentLook(agent)} size={size} mode={mode} live={live} />;
}
