import { isOutOfOffice } from "@agenteschat/client/lib/presence";
import { splitAtNames } from "@agenteschat/client/lib/text";
import { Fragment, type ReactNode } from "react";
import { Text as RNText, StyleSheet, View } from "react-native";
import type { AgentLookInput } from "@/agent/looks";
import { type AgentMode, agentLayout, framedByDefault } from "@/agent/poses";
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
  mode?: AgentMode;
  live?: boolean;
  /** Agents only: the sky tile (default by size, see AgentAvatar). */
  framed?: boolean;
  presence?: boolean;
  ring?: string;
}) {
  const dir = useDirectory();
  const member = who?.type !== "agent" && who?.id ? dir.memberById.get(who.id) : undefined;
  const photo = usePersonPhoto(member ? (member.avatarUrl ?? member.image) : null);
  if (who?.type === "agent")
    return (
      <AgentFace agentId={who.id} size={size} mode={mode} live={live} framed={framed} presence={presence} ring={ring} />
    );
  const face = <PersonAvatar name={dir.nameOf(who) || "?"} size={size} photo={photo} />;
  if (!presence || !who?.id) return face;
  return (
    <Badged who={{ type: who.type, id: who.id }} size={size} ring={ring} inset={0}>
      {face}
    </Badged>
  );
}

/** An agent by id (its look from the directory); with `presence`, asleep while it is out of office. */
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
  mode?: AgentMode;
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
  if (presence && agentId)
    return (
      <PresentAgentFace agentId={agentId} look={look} size={size} mode={mode} live={live} framed={framed} ring={ring} />
    );
  return <AgentAvatar agent={look} size={size} mode={mode} live={live} framed={framed} />;
}

function PresentAgentFace({
  agentId,
  look,
  size,
  mode,
  live,
  framed,
  ring,
}: {
  agentId: string;
  look: AgentLookInput;
  size: number;
  mode: AgentMode;
  live: boolean;
  framed: boolean | undefined;
  ring: string | undefined;
}) {
  const status = usePresenceOf().agent(agentId)?.status?.status;
  const asleep = mode === "idle" && isOutOfOffice(status);
  return (
    <Badged who={{ type: "agent", id: agentId }} size={size} ring={ring} inset={agentBadgeInset(look, size, framed)}>
      <AgentAvatar agent={look} size={size} mode={asleep ? "sleep" : mode} live={live} framed={framed} />
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

/**
 * An agent named in a line of text: its still face, the text's size, then its name (the web's `.ac-who`). A child of a
 * `<Text>`; the face is an inline view lifted onto the capitals. A space plus 0.2 of the size before it, 0.4 after, as
 * on the web; `lead` (it opens the text) drops the one before.
 */
export function AgentWho({
  agentId,
  name,
  size = 14,
  lead = false,
}: {
  agentId: string | null | undefined;
  name: string;
  size?: number;
  lead?: boolean;
}) {
  const side = { marginLeft: lead ? 0 : Math.round(size * 0.2), marginRight: Math.round(size * 0.4) };
  return (
    <RNText style={whoStyles.who}>
      <View style={[whoStyles.face, { width: size, height: size }, side]}>
        <AgentFace agentId={agentId} size={size} live={false} />
      </View>
      {name}
    </RNText>
  );
}

/** `text` with each agent's name, where it first stands as a word, drawn as `AgentWho`: children for a `<Text>`. */
export function withAgentFaces(
  text: string,
  who: { name: string; agentId: string | null | undefined }[],
  size?: number,
) {
  const parts = splitAtNames(
    text,
    who.map((w) => w.name),
  );
  if (parts.every((p) => typeof p === "string")) return text;
  return parts.map((p, i) =>
    typeof p === "string" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
      <Fragment key={i}>{p}</Fragment>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: same
      <AgentWho key={i} agentId={who[p]?.agentId} name={who[p]?.name ?? ""} size={size} lead={i === 0} />
    ),
  );
}

const whoStyles = StyleSheet.create({
  who: { fontWeight: "600" },
  face: { transform: [{ translateY: 2 }] },
});
