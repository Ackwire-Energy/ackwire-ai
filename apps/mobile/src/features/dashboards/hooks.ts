import {
  type Dashboard,
  useDashboard,
  useHomeDashboard,
  useRoles,
  type Widget,
  widgetFailureKey,
} from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { exampleWordsOf, HOME } from "./logic";

/** An agent's name and color by id (one that left the team keeps its look on what it made). */
export function useAgentLook(agentId: string | null | undefined): { name: string; color: AgentColorName } {
  const dir = useDirectory();
  const agent = agentId ? dir.anyAgent(agentId) : undefined;
  return { name: agent?.name ?? "", color: agentLook(agent).color };
}

/** The words of a preview's example data, in the reader's language. */
export function useExampleWords() {
  const { t } = useTranslation();
  return useMemo(() => exampleWordsOf((key) => t(key)), [t]);
}

/** A board by id, or My Home (`home`): made the first time it is opened. */
export function useBoard(id: string): {
  board: Dashboard | undefined;
  loading: boolean;
  failed: boolean;
  refetch: () => Promise<unknown>;
} {
  const orgId = useOrgId();
  const home = useHomeDashboard(orgId, id === HOME);
  const one = useDashboard(orgId, id === HOME ? null : id);
  const q = id === HOME ? home : one;
  return { board: q.data, loading: q.isLoading, failed: q.isError && !q.data, refetch: q.refetch };
}

/** The workspace's own roles (not "everyone"), top first: Share's chips and a board's line. */
export function useCustomRoles() {
  const roles = useRoles(useOrgId());
  return useMemo(() => sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))), [roles.data]);
}

/** What a widget says about itself: why it didn't update, and when it last did ("12 min ago"). */
export function useWidgetWords() {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const failure = useCallback(
    (w: Pick<Widget, "failure" | "agentId">) => {
      if (!w.failure) return "";
      const name = dir.anyAgent(w.agentId)?.name ?? "";
      if (w.failure.code === "agent_reported") return w.failure.detail || t("widgets.failure.error");
      return t(widgetFailureKey(w.failure.code), { name, detail: w.failure.detail ?? "" });
    },
    [t, dir],
  );
  const ago = useCallback((iso: string) => relativeTime(t, i18n.language, iso), [t, i18n.language]);
  return { failure, ago, locale: i18n.language };
}
