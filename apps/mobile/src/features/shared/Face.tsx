import type { ReactNode } from "react";
import type { AgentLookInput } from "@/agent/looks";
import { agentLayout, framedByDefault } from "@/agent/poses";
import { AgentAvatar, PersonAvatar, WithPresence } from "@/ui";
import { usePresenceOf } from "../status/hooks";
import { useDirectory } from "./hooks";
import { agentLook } from "./logic";
import { usePersonPhoto } from "./photo";

/**
 * A person's or an agent's face. Agents are living bodies; long lists pass
 * `live={false}` (a still frame). `presence`: its badge on the corner (ADR 0084), ringed in `ring` (the surface
 * behind; default the page's color).
 */
export function Face({
  who,
  size,
  mode = "idle",
  live = true,
  framed,
  presence = false,
  ring,
}: {
  who: { type: string; id: string | null } | null | undefined;
  size: number;
  mode?: "idle" | "run" | "think" | "rest";
  live?: boolean;
  /** Agents only: the sky tile (default by size, see AgentAvatar). */
  framed?: boolean;
  presence?: boolean;
  ring?: string;
}) {
  const dir = useDirectory();
  const member = who?.type !== "agent" && who?.id ? dir.memberById.get(who.id) : undefined;
  const photo = usePersonPhoto(member ? (member.avatarUrl ?? member.image) : null);
  const look = who?.type === "agent" ? agentLook(who.id ? dir.anyAgent(who.id) : undefined) : null;
  const face = look ? (
    <AgentAvatar agent={look} size={size} mode={mode} live={live} framed={framed} />
  ) : (
    <PersonAvatar name={dir.nameOf(who) || "?"} size={size} photo={photo} />
  );
  if (!presence || !who?.id) return face;
  return (
    <Badged
      who={{ type: who.type, id: who.id }}
      size={size}
      ring={ring}
      inset={look ? agentBadgeInset(look, size, framed) : 0}
    >
      {face}
    </Badged>
  );
}

/** An agent by id (its look from the directory). */
export function AgentFace({
  agentId,
  size,
  mode = "idle",
  live = true,
  framed,
  presence = false,
  ring,
}: {
  agentId: string | null | undefined;
  size: number;
  mode?: "idle" | "run" | "think" | "rest";
  live?: boolean;
  /** The sky tile (default by size, see AgentAvatar). */
  framed?: boolean;
  /** Its presence badge on the corner (ADR 0084). */
  presence?: boolean;
  /** The surface behind the badge (default the page's color). */
  ring?: string;
}) {
  const dir = useDirectory();
  const look = agentLook(agentId ? dir.anyAgent(agentId) : undefined);
  const face = <AgentAvatar agent={look} size={size} mode={mode} live={live} framed={framed} />;
  if (!presence || !agentId) return face;
  return (
    <Badged who={{ type: "agent", id: agentId }} size={size} ring={ring} inset={agentBadgeInset(look, size, framed)}>
      {face}
    </Badged>
  );
}

/**
 * Where an agent's badge sits in from its box's right edge: in a tile, at the tile's corner; standing on its own
 * (the tiny faces, the big hero), at its body's (`agentLayout`), narrower than the box.
 */
export function agentBadgeInset(look: AgentLookInput, size: number, framed?: boolean): number {
  if (framed ?? framedByDefault(size)) return 0;
  const accessory = Boolean(look.accessory && look.accessory !== "none");
  return Math.round((size - agentLayout(size, accessory).inner) / 2);
}

/** A face with its presence (people's from the people, agents' from their work); none while it loads. */
function Badged({
  who,
  size,
  ring,
  inset,
  children,
}: {
  who: { type: string; id: string };
  size: number;
  ring: string | undefined;
  inset: number;
  children: ReactNode;
}) {
  const of = usePresenceOf();
  const presence = who.type === "agent" ? of.agent(who.id)?.presence : of.person(who.id)?.presence;
  return (
    <WithPresence size={size} presence={presence} inset={inset} {...(ring !== undefined ? { ring } : {})}>
      {children}
    </WithPresence>
  );
}
