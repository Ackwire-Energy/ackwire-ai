import { AgentAvatar, PersonAvatar } from "@/ui";
import { useDirectory } from "./hooks";
import { agentLook } from "./logic";
import { usePersonPhoto } from "./photo";

/**
 * A person's or an agent's face. Agents are living bodies; long lists pass
 * `live={false}` (a still frame).
 */
export function Face({
  who,
  size,
  mode = "idle",
  live = true,
  framed,
}: {
  who: { type: string; id: string | null } | null | undefined;
  size: number;
  mode?: "idle" | "run" | "think" | "rest";
  live?: boolean;
  /** Agents only: the sky tile (default by size, see AgentAvatar). */
  framed?: boolean;
}) {
  const dir = useDirectory();
  const member = who?.type !== "agent" && who?.id ? dir.memberById.get(who.id) : undefined;
  const photo = usePersonPhoto(member ? (member.avatarUrl ?? member.image) : null);
  if (who?.type === "agent") {
    const agent = who.id ? dir.anyAgent(who.id) : undefined;
    return <AgentAvatar agent={agentLook(agent)} size={size} mode={mode} live={live} framed={framed} />;
  }
  return <PersonAvatar name={dir.nameOf(who) || "?"} size={size} photo={photo} />;
}

/** An agent by id (its look from the directory). */
export function AgentFace({
  agentId,
  size,
  mode = "idle",
  live = true,
  framed,
}: {
  agentId: string | null | undefined;
  size: number;
  mode?: "idle" | "run" | "think" | "rest";
  live?: boolean;
  /** The sky tile (default by size, see AgentAvatar). */
  framed?: boolean;
}) {
  const dir = useDirectory();
  const agent = agentId ? dir.anyAgent(agentId) : undefined;
  return <AgentAvatar agent={agentLook(agent)} size={size} mode={mode} live={live} framed={framed} />;
}
