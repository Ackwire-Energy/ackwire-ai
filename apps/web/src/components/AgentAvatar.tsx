import { type AgentAppearance, type AgentState, Avatar, type AvatarProps } from "@agenteschat/ui";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useStreams } from "@/realtime/context";
import { agentStateIn } from "@/realtime/streams";

type AgentAvatarProps = Omit<AvatarProps, "kind" | "running" | "state" | "appearance"> & {
  /** A real agent: its look from the directory, its live state from the run store. */
  agentId?: string;
  /** An agent object at hand (an onboarding preset, the customizer's draft). */
  agent?: { id?: string; appearance?: unknown } | null;
  /** Overrides the look (the customizer's preview and choices). */
  appearance?: AgentAppearance;
  channelId?: string;
  state?: AgentState;
  /** Shows the "running" halo (a preview without a live run). */
  running?: boolean;
};

/**
 * The only way `apps/web` draws an agent: the living symbol with the agent's
 * appearance (color, eyes, accessory) and, for a real agent, the live run
 * state (looks around while it thinks, dash eyes while words arrive).
 * `channelId` limits the state to one conversation; `state` overrides it.
 */
export function AgentAvatar(props: AgentAvatarProps) {
  const id = props.agentId ?? props.agent?.id;
  if (id) return <LiveAgentAvatar {...props} agentId={id} />;
  const { agent, appearance, state, running, channelId: _c, agentId: _a, ...rest } = props;
  return (
    <Avatar
      kind="agent"
      appearance={appearance ?? lookOf(agent)}
      state={state ?? (running ? "thinking" : undefined)}
      {...rest}
    />
  );
}

function LiveAgentAvatar({
  agentId,
  agent,
  appearance,
  channelId,
  state,
  running,
  ...rest
}: AgentAvatarProps & { agentId: string }) {
  const live = useStreams((s) => agentStateIn(s, agentId, channelId));
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const known = dir.agentById.get(agentId);
  return (
    <Avatar
      kind="agent"
      state={state ?? (running && live === "idle" ? "thinking" : live)}
      appearance={appearance ?? lookOf(known ?? agent)}
      initials={dir.agentInitials(agentId)}
      {...rest}
    />
  );
}

/**
 * Anyone's avatar by actor: agents get the living symbol with their look,
 * people their photo or initials.
 */
export function ActorAvatar({
  actor,
  name,
  ...rest
}: Omit<AvatarProps, "kind" | "running" | "state" | "imageUrl" | "appearance"> & {
  actor: { type: "agent" | "person"; id: string };
}) {
  if (actor.type === "agent") return <AgentAvatar agentId={actor.id} name={name} {...rest} />;
  return <PersonAvatar id={actor.id} name={name} {...rest} />;
}

function PersonAvatar({ id, name, ...rest }: Omit<AvatarProps, "kind" | "imageUrl"> & { id: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return <Avatar kind="person" name={name} imageUrl={dir.memberById.get(id)?.image} {...rest} />;
}
