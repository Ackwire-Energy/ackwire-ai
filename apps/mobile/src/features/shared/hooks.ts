import {
  type Agent,
  type Edition,
  type Member,
  type RealtimeConnection,
  useAgents,
  useComputerSetup,
  useFormerAgents,
  useMe,
  useMembers,
} from "@agenteschat/client";
import { computerEdition } from "@agenteschat/client/lib/computer";
import { formerById } from "@agenteschat/client/lib/directory";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useRealtime } from "@/providers/realtime";
import { rememberAgentLooks, useTheme } from "@/ui";
import { agentLook, daysAgo, whenKind } from "./logic";

/** The current organization's id. */
export function useOrgId(): string {
  return useOrg().orgId;
}

/** Which words the computers get here: the Cloud's or self-host's (`computerEdition`); null while loading. */
export function useEdition(): Edition | null {
  return computerEdition(useComputerSetup(useOrgId()).data);
}

/** The signed-in person's id (null while it loads). */
export function useMeId(): string | null {
  return useMe().data?.user.id ?? null;
}

export interface Directory {
  agents: Agent[];
  agentById: Map<string, Agent>;
  /** The team's agent, or one no longer in it (archived or deleted): what it left still names it. */
  anyAgent: (id: string) => Agent | undefined;
  memberById: Map<string, Member>;
  loading: boolean;
  /** A person's or an agent's name ("" when unknown). */
  nameOf: (who: { type: string; id: string | null } | null | undefined) => string;
}

/** Agents and people of the organization, by id. */
export function useDirectory(): Directory {
  const orgId = useOrgId();
  const agents = useAgents(orgId);
  const former = useFormerAgents(orgId);
  const members = useMembers(orgId);
  return useMemo(() => {
    const agentById = new Map((agents.data ?? []).map((a) => [a.id, a]));
    const gone = formerById(former.data);
    const anyAgent = (id: string) => agentById.get(id) ?? gone.get(id);
    const memberById = new Map((members.data ?? []).map((m) => [m.userId, m]));
    return {
      agents: agents.data ?? [],
      agentById,
      anyAgent,
      memberById,
      loading: agents.isLoading || members.isLoading,
      nameOf: (who) => {
        if (!who?.id) return "";
        return who.type === "agent" ? (anyAgent(who.id)?.name ?? "") : (memberById.get(who.id)?.name ?? "");
      },
    };
  }, [agents.data, former.data, members.data, agents.isLoading, members.isLoading]);
}

/** Toasts and other places that only know an agent's id draw it from these looks (once, at the app's root). */
export function useRememberAgentLooks() {
  const agents = useAgents(useOrgId());
  useEffect(() => {
    if (agents.data) rememberAgentLooks(agents.data.map((a) => ({ id: a.id, ...agentLook(a) })));
  }, [agents.data]);
}

/** The organization's WebSocket (null until it opens). */
export function useConnection(): RealtimeConnection | null {
  return useRealtime().connection;
}

/** Theme colors by token name (`bg`, `raised`, `sunken`, `line`, `ink`, `muted`, `faint`, `agent`, `danger`…). */
export function useColors() {
  return useTheme().colors;
}

/** Times as the lists say them: "9:41" today, "Ontem", "seg", "12 out". */
export function useWhen() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || "pt-BR";
  return useMemo(() => {
    const time = (iso: string) =>
      new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
    const short = (iso: string) => {
      switch (whenKind(iso)) {
        case "time":
          return time(iso);
        case "yesterday":
          return t("mobile.time.yesterday");
        case "weekday":
          return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(iso)).replace(".", "");
        case "date":
          return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" })
            .format(new Date(iso))
            .replace(".", "");
      }
    };
    const day = (iso: string) => {
      const d = daysAgo(iso);
      if (d <= 0) return t("mobile.time.today");
      if (d === 1) return t("mobile.time.yesterday");
      return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
    };
    return { time, short, day, locale };
  }, [t, locale]);
}

/** The current time, refreshed every `ms` (fuses, "expira em", clocks). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * Pull to refresh that spins only for the person's own pull. Driving `RefreshControl` from a query's
 * `isRefetching` made every background refetch (realtime, polling, focus) start the spinner from code,
 * and on iOS that moves the scroll view by the spinner's height without counting the native header's
 * inset: the content slid up under the large title.
 */
export function usePullRefresh(refetch: () => Promise<unknown>): { refreshing: boolean; onRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(refetch);
  useEffect(() => {
    latest.current = refetch;
  });
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.resolve()
      .then(() => latest.current())
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);
  return { refreshing, onRefresh };
}
