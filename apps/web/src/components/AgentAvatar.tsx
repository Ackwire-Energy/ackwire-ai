import type { AgentPresence } from "@agenteschat/client";
import { agentStateIn } from "@agenteschat/client";
import {
  type AgentAppearance,
  type AgentState,
  Avatar,
  type AvatarProps,
  PixelSpinner,
  type PixelSpinnerSize,
} from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useAgentPresence, usePersonPresence } from "@/hooks/usePresence";
import { lookOf } from "@/lib/look";
import { useStreams } from "@/realtime/context";

type AgentAvatarProps = Omit<AvatarProps, "kind" | "running" | "state" | "appearance" | "presence"> & {
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
  /**
   * Its presence badge (ADR 0084): `true` reads it live (from its work, offline with no AI), a value draws that one.
   * Only where presence matters (the sidebar, member lists, profile cards, messages), never on the tiny receipts.
   */
  presence?: boolean | AgentPresence | null;
};

/**
 * The only way `apps/web` draws an agent: the living symbol with the agent's
 * appearance (color, eyes, accessory) and, for a real agent, the live run
 * state (looks around while it thinks, dash eyes while words arrive).
 * `channelId` limits the state to one conversation; `state` overrides it.
 */
export function AgentAvatar(props: AgentAvatarProps) {
  const id = props.agentId ?? props.agent?.id;
  if (id && props.presence === true) return <PresentAgentAvatar {...props} agentId={id} />;
  const given = typeof props.presence === "string" ? props.presence : null;
  if (id) return <LiveAgentAvatar {...props} presence={given} agentId={id} />;
  const { agent, appearance, state, running, channelId: _c, agentId: _a, presence: _p, ...rest } = props;
  return (
    <Avatar
      kind="agent"
      appearance={appearance ?? lookOf(agent)}
      state={state ?? (running ? "thinking" : undefined)}
      presence={given}
      {...rest}
    />
  );
}

/** A real agent with its live presence badge. */
function PresentAgentAvatar(props: AgentAvatarProps & { agentId: string }) {
  const { t } = useTranslation();
  const shown = useAgentPresence(props.agentId);
  return (
    <LiveAgentAvatar
      {...props}
      presence={shown?.presence ?? null}
      presenceLabel={shown ? t(`presence.${shown.presence}`) : undefined}
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
  presence,
  ...rest
}: Omit<AgentAvatarProps, "presence"> & { agentId: string; presence: AgentPresence | null }) {
  const live = useStreams((s) => agentStateIn(s, agentId, channelId));
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const known = dir.anyAgent(agentId);
  return (
    <Avatar
      kind="agent"
      state={state ?? (running && live === "idle" ? "thinking" : live)}
      appearance={appearance ?? lookOf(known ?? agent)}
      initials={dir.agentInitials(agentId)}
      presence={presence}
      {...rest}
    />
  );
}

/**
 * The working indicator for an agent's work (the pixel orbit in its own
 * tones); the neutral one is `Icon name="spinner"` / `PixelSpinner` alone.
 */
export function AgentSpinner({
  agentId,
  size = 14,
  label,
}: {
  agentId: string | null | undefined;
  size?: PixelSpinnerSize;
  label?: string;
}) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  return <PixelSpinner size={size} color={agent ? colorOf(agent) : undefined} label={label} />;
}

/**
 * Anyone's avatar by actor: agents get the living symbol with their look,
 * people their photo or initials.
 */
export function ActorAvatar({
  actor,
  name,
  ...rest
}: Omit<AvatarProps, "kind" | "running" | "state" | "imageUrl" | "appearance" | "presence"> & {
  actor: { type: "agent" | "person"; id: string };
  /** The live presence badge (ADR 0084). */
  presence?: boolean;
}) {
  if (actor.type === "agent") return <AgentAvatar agentId={actor.id} name={name} {...rest} />;
  return <PersonAvatar id={actor.id} name={name} {...rest} />;
}

type PersonAvatarProps = Omit<AvatarProps, "kind" | "imageUrl" | "presence"> & {
  id: string;
  /** The live presence badge (ADR 0084): as others see them (a hidden person reads offline), yours as you chose. */
  presence?: boolean;
};

/** A workspace member's face: the uploaded photo (or the sign-in one) or initials. */
export function PersonAvatar({ id, presence, ...rest }: PersonAvatarProps) {
  if (presence) return <PresentPersonAvatar id={id} {...rest} />;
  return <MemberAvatar id={id} presence={null} {...rest} />;
}

function PresentPersonAvatar({ id, ...rest }: Omit<PersonAvatarProps, "presence">) {
  const { t } = useTranslation();
  const shown = usePersonPresence(id);
  return (
    <MemberAvatar
      id={id}
      presence={shown?.presence ?? null}
      presenceLabel={shown ? t(`presence.${shown.presence}`) : undefined}
      {...rest}
    />
  );
}

function MemberAvatar({ id, name, ...rest }: Omit<AvatarProps, "kind" | "imageUrl"> & { id: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return <Avatar kind="person" name={name} imageUrl={dir.memberById.get(id)?.image} {...rest} />;
}
