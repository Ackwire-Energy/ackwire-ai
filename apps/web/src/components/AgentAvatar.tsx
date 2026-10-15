import { type AgentState, Avatar, type AvatarProps } from "@agenteschat/ui";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useStreams } from "@/realtime/context";
import { agentStateIn } from "@/realtime/streams";

/**
 * The living agent symbol, wired to the real-time run state: it looks around
 * while the agent thinks (queued, calling tools) and gets dash eyes while
 * words arrive. `channelId` limits it to one conversation; `state` overrides.
 */
export function AgentAvatar({
  agentId,
  channelId,
  state,
  ...rest
}: Omit<AvatarProps, "kind" | "running" | "state"> & { agentId: string; channelId?: string; state?: AgentState }) {
  const live = useStreams((s) => agentStateIn(s, agentId, channelId));
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return <Avatar kind="agent" state={state ?? live} appearance={lookOf(dir.agentById.get(agentId))} {...rest} />;
}
