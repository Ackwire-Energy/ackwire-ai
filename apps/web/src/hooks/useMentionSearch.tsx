import { Avatar, type ComposerSuggestion } from "@agenteschat/ui";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ChannelMember } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { handleFrom } from "@/lib/text";
import { useDirectory } from "./useDirectory";

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const LIMIT = 8;

type Row = ComposerSuggestion & { inChannel: boolean; rank: number; hay: string };

/**
 * "@" suggestions: the channel's members first (people and agents), then the
 * rest of the workspace. Agents outside the channel say so (`note`).
 * Without `members` (an issue), everyone is one list.
 */
export function useMentionSearch(members?: ChannelMember[]) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  return useCallback(
    (query: string): ComposerSuggestion[] => {
      const q = fold(query);
      const inChannel = (type: "person" | "agent", id: string) =>
        !members || members.some((m) => m.type === type && m.id === id);
      const rows: Row[] = [
        ...dir.agents.map((a) => {
          const here = inChannel("agent", a.id);
          return {
            key: `agent:${a.id}`,
            insert: a.handle,
            label: a.name,
            description: [`@${a.handle}`, a.role ? t("issues.agentRole", { role: a.role }) : null]
              .filter(Boolean)
              .join(" · "),
            leading: <Avatar kind="agent" size="xs" name={a.name} initials={dir.agentInitials(a.id)} />,
            note: here ? undefined : t("mentions.notInChannel"),
            inChannel: here,
            rank: fold(a.name).startsWith(q) || fold(a.handle).startsWith(q) ? 0 : 1,
            hay: `${fold(a.name)} ${fold(a.handle)}`,
          };
        }),
        ...dir.members
          .filter((m) => m.userId !== me.user.id)
          .map((m) => {
            const handle = handleFrom(m.name);
            return {
              key: `person:${m.userId}`,
              insert: handle,
              label: m.name,
              description: `@${handle}`,
              leading: <Avatar kind="person" size="xs" name={m.name} imageUrl={m.image} />,
              inChannel: inChannel("person", m.userId),
              rank: fold(m.name).startsWith(q) || handle.startsWith(q) ? 0 : 1,
              hay: `${fold(m.name)} ${handle} ${fold(m.email)}`,
            };
          }),
      ];
      const all = rows.filter((s) => !q || s.hay.includes(q));
      const here = t("mentions.inChannel");
      const rest = t("mentions.inWorkspace");
      const sorted = all.sort(
        (a, b) => Number(b.inChannel) - Number(a.inChannel) || a.rank - b.rank || a.label.localeCompare(b.label),
      );
      return sorted.slice(0, LIMIT).map(({ inChannel: on, rank: _r, hay: _h, ...s }) => ({
        ...s,
        group: members ? (on ? here : rest) : undefined,
      }));
    },
    [dir, members, me.user.id, t],
  );
}
