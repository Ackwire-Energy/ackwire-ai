import { Avatar, type SelectOption } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import type { Actor } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

export const NO_ACTOR = "none";
export const actorKey = (a: Actor | null | undefined) => (a ? `${a.type}:${a.id}` : NO_ACTOR);
export function actorFromKey(key: string): Actor | null {
  const [type, id] = key.split(":");
  return (type === "agent" || type === "person") && id ? { type, id } : null;
}

/** People and agents of the workspace for pickers and labels. */
export function useActors() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const name = (a: Actor) => dir.authorName({ type: a.type, id: a.id } as Parameters<typeof dir.authorName>[0]);
  const options = (withNone: boolean): SelectOption[] => [
    ...(withNone ? [{ value: NO_ACTOR, label: t("issues.noAssignee") }] : []),
    ...dir.members.map((m) => ({ value: `person:${m.userId}`, label: m.name })),
    ...dir.agents.map((a) => ({
      value: `agent:${a.id}`,
      label: a.name,
      description: a.role ? t("issues.agentRole", { role: a.role }) : undefined,
    })),
  ];
  const avatar = (a: Actor, size: "xs" | "sm" = "xs") => (
    <Avatar
      size={size}
      kind={a.type}
      name={name(a)}
      initials={a.type === "agent" ? dir.agentInitials(a.id) : undefined}
      imageUrl={a.type === "person" ? dir.memberById.get(a.id)?.image : undefined}
    />
  );
  return { dir, name, options, avatar, meId: me.user.id };
}

/** Avatar + name, inline. */
export function ActorLabel({ actor }: { actor: Actor }) {
  const { name, avatar } = useActors();
  return (
    <span className="actor-label">
      {avatar(actor)}
      <span>{name(actor)}</span>
    </span>
  );
}
