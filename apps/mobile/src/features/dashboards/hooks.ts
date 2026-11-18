import {
  type Dashboard,
  frozenBoard,
  useDashboard,
  useHomeDashboard,
  useRoles,
  type Widget,
  widgetFailureText,
  widgetWaiting,
  widgetWaitText,
} from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { maySetAgentAi, noAiLockedLine, planKeyIntent } from "@agenteschat/client/lib/no-ai";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { HOME } from "./logic";

/** An agent's name and color by id (one that left the team keeps its look on what it made). */
export function useAgentLook(agentId: string | null | undefined): { name: string; color: AgentColorName } {
  const dir = useDirectory();
  const agent = agentId ? dir.anyAgent(agentId) : undefined;
  return { name: agent?.name ?? "", color: agentLook(agent).color };
}

/**
 * A board by id, or My Home (`home`): made the first time it is opened. In a workspace being deleted it offers no
 * change (`frozenBoard`), as on the web.
 */
export function useBoard(id: string): {
  board: Dashboard | undefined;
  loading: boolean;
  failed: boolean;
  refetch: () => Promise<unknown>;
} {
  const { orgId, org } = useOrg();
  const home = useHomeDashboard(orgId, id === HOME);
  const one = useDashboard(orgId, id === HOME ? null : id);
  const q = id === HOME ? home : one;
  return {
    board: q.data && frozenBoard(q.data, org),
    loading: q.isLoading,
    failed: q.isError && !q.data,
    refetch: q.refetch,
  };
}

/** The workspace's own roles (not "everyone"), top first: Share's chips and a board's line. */
export function useCustomRoles() {
  const roles = useRoles(useOrgId());
  return useMemo(() => sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))), [roles.data]);
}

/**
 * What a widget says about itself: why it didn't update, what its refresh waits for ("Waiting for Theo's plan to reset
 * at 13:00", "" when nothing does), and when it last updated ("12 min ago"). `now` moves on every minute, so a wait
 * reads as over once its reset passes, and room on the computer is said once it waited long enough.
 */
export function useWidgetWords() {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const now = useNow(60_000);
  const failure = useCallback(
    (w: Pick<Widget, "failure" | "agentId">) => {
      if (!w.failure) return "";
      const name = dir.anyAgent(w.agentId)?.name ?? "";
      return widgetFailureText(t, w.failure, name);
    },
    [t, dir],
  );
  const wait = useCallback(
    (w: Pick<Widget, "status" | "agentId"> & { wait?: Widget["wait"] }) => {
      const waiting = widgetWaiting({ status: w.status, wait: w.wait ?? null }, now);
      const name = dir.anyAgent(w.agentId)?.name ?? "";
      return waiting ? widgetWaitText(t, i18n.language, waiting, name, new Date(now)) : "";
    },
    [t, i18n.language, dir, now],
  );
  const ago = useCallback((iso: string) => relativeTime(t, i18n.language, iso, new Date(now)), [t, i18n.language, now]);
  return { failure, wait, ago, now, locale: i18n.language };
}

/**
 * What a widget waiting for an AI offers this person (its screen, its card's footer, New widget's test), as the web's:
 * Connect to whoever may set its agent's AI (for the right hand the workspace's, which a build falls back to when the
 * AI of whoever made the widget can't think; on a plan that can't take it, `reason` a plan line, a key:
 * `planKeyIntent`), else who can. Nothing on a billing hold: an AI comes after the plan.
 */
export function useWidgetAiWay(
  agentId: string | null | undefined,
  reason?: string | null,
): { connect: () => void } | { locked: string } | null {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const hold = usePlanHold(orgId, org);
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  if (!agent || hold) return null;
  if (maySetAgentAi(agent, meId, org))
    return { connect: () => openConnectAi({ agentId: agent.id, ...planKeyIntent(agent, reason) }) };
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : null;
  return { locked: noAiLockedLine(t, agent.name, owner) };
}
