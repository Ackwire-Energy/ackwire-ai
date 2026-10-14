import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAgents, useMembers } from "@/api/queries";
import type { Agent, Member, Message } from "@/api/types";

/** People and agents of the organization, by id and handle, for names and avatars. */
export function useDirectory(orgId: string) {
  const { t } = useTranslation();
  const agents = useAgents(orgId);
  const members = useMembers(orgId);
  return useMemo(() => {
    const agentById = new Map<string, Agent>((agents.data ?? []).map((a) => [a.id, a]));
    const agentByHandle = new Map<string, Agent>((agents.data ?? []).map((a) => [a.handle.toLowerCase(), a]));
    const memberById = new Map<string, Member>((members.data ?? []).map((m) => [m.userId, m]));
    const authorName = (author: Message["author"]) =>
      author.type === "agent"
        ? (agentById.get(author.id ?? "")?.name ?? t("channel.unknownAgent"))
        : (memberById.get(author.id ?? "")?.name ?? t("channel.unknownPerson"));
    // Agents sharing a first letter get two (Ada "A", Atlas "At"), as in the approved screens.
    const initials = new Map<string, string>();
    const used = new Set<string>();
    for (const a of agents.data ?? []) {
      const first = (a.name.trim()[0] ?? "?").toUpperCase();
      const value = used.has(first) ? `${first}${a.name.trim()[1] ?? ""}` : first;
      used.add(first);
      initials.set(a.id, value);
    }
    const agentInitials = (agentId: string) => initials.get(agentId);
    /** `@ada` → "Ada" (agents); unknown handles stay as typed. */
    const mentionName = (handle: string) => agentByHandle.get(handle.toLowerCase())?.name ?? null;
    return {
      agents: agents.data ?? [],
      members: members.data ?? [],
      agentById,
      memberById,
      authorName,
      mentionName,
      agentInitials,
      loading: agents.isPending || members.isPending,
    };
  }, [agents.data, members.data, agents.isPending, members.isPending, t]);
}
