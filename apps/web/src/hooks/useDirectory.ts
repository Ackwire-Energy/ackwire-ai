import type { Agent, Member, Message } from "@agenteschat/client";
import { useAgents, useFormerAgents, useMembers } from "@agenteschat/client";
import { agentsByAnyHandle, formerById } from "@agenteschat/client/lib/directory";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/** People and agents of the organization, by id and handle, for names and avatars. */
export function useDirectory(orgId: string) {
  const { t } = useTranslation();
  const agents = useAgents(orgId);
  const former = useFormerAgents(orgId);
  const members = useMembers(orgId);
  return useMemo(() => {
    const agentById = new Map<string, Agent>((agents.data ?? []).map((a) => [a.id, a]));
    const gone = formerById(former.data);
    /** The team's agent, or one no longer in it (archived or deleted): what it left still names it. */
    const anyAgent = (id: string) => agentById.get(id) ?? gone.get(id);
    const agentByHandle = agentsByAnyHandle(agents.data ?? []);
    // The uploaded photo wins over the sign-in image (`image` is what every avatar reads).
    const people = (members.data ?? []).map((m) => (m.avatarUrl ? { ...m, image: m.avatarUrl } : m));
    const memberById = new Map<string, Member>(people.map((m) => [m.userId, m]));
    const memberByHandle = new Map<string, Member>(
      (members.data ?? []).filter((m) => m.handle).map((m) => [m.handle.toLowerCase(), m]),
    );
    const authorName = (author: Message["author"]) =>
      author.type === "agent"
        ? (anyAgent(author.id ?? "")?.name ?? t("channel.unknownAgent"))
        : (memberById.get(author.id ?? "")?.name ?? t("channel.unknownPerson"));
    // Agents sharing a first letter get two (Ada "A", Atlas "At").
    const initials = new Map<string, string>();
    const used = new Set<string>();
    for (const a of agents.data ?? []) {
      const first = (a.name.trim()[0] ?? "?").toUpperCase();
      const value = used.has(first) ? `${first}${a.name.trim()[1] ?? ""}` : first;
      used.add(first);
      initials.set(a.id, value);
    }
    const agentInitials = (agentId: string) => initials.get(agentId);
    /** `@ada` → "Ada", `@joao` → "João"; unknown handles stay as typed. */
    const mentionName = (handle: string) =>
      agentByHandle.get(handle.toLowerCase())?.name ?? memberByHandle.get(handle.toLowerCase())?.name ?? null;
    return {
      agents: agents.data ?? [],
      members: people,
      agentById,
      anyAgent,
      agentByHandle,
      memberById,
      memberByHandle,
      authorName,
      mentionName,
      agentInitials,
      loading: agents.isPending || members.isPending,
    };
  }, [agents.data, former.data, members.data, agents.isPending, members.isPending, t]);
}
