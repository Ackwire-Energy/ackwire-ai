import { type SidebarPins, useAgentGroups, useDms, useSetSidebarView, useSidebarView } from "@agenteschat/client";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { dayOnePins, type PinKind, pinsOf, togglePin } from "@agenteschat/client/lib/sidebar-view";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useToast } from "@/ui";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";

/**
 * "Fixar no topo", the web sidebar's pins on the phone: the same per-person pins (`…/me/sidebar/view`), on top of
 * Conversas' Agentes, Canais and Pessoas and of Agentes' Livres. Day one, the person's own agents.
 */
export function usePins(): {
  pins: SidebarPins;
  /** The person chose these pins (false: day one's default, the agents they made, nothing they did). */
  chosen: boolean;
  isPinned: (kind: PinKind, id: string) => boolean;
  toggle: (kind: PinKind, id: string) => void;
} {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const toast = useToast();
  const dir = useDirectory();
  const dms = useDms(orgId).data;
  const groups = useAgentGroups(orgId).data;
  const view = useSidebarView(orgId);
  const setView = useSetSidebarView(orgId);
  const lastActive = new Map<string, string>();
  for (const d of dms ?? [])
    if (d.with.type === "agent" && d.lastMessage) lastActive.set(d.with.id, d.lastMessage.createdAt);
  const dayOne = meId
    ? dayOnePins(
        dir.agents.filter((a) => !isRightHand(a) && listsAgent(org, a)),
        meId,
        lastActive,
        groups,
      )
    : [];
  const pins = pinsOf(view, dayOne);
  return {
    pins,
    chosen: view.pins != null,
    isPinned: (kind, id) => pins[kind].includes(id),
    toggle: (kind, id) => {
      if (!togglePin(pins, kind, id)) {
        toast({ title: t(`sidebarPins.full.${kind}`), icon: "pin" });
        return;
      }
      setView((now) => {
        const from = pinsOf(now, dayOne);
        const next = togglePin(from, kind, id) ?? from;
        // What the person pins goes on top of its section, so the pin shows where it lands (it went last, among the
        // agents pinned by default, and nothing seemed to change).
        const pinning = !from[kind].includes(id) && next[kind].includes(id);
        return { ...now, pins: pinning ? { ...next, [kind]: [id, ...next[kind].filter((x) => x !== id)] } : next };
      });
    },
  };
}
