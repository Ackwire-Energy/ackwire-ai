import { type OrgSummary, useMe } from "@agenteschat/client";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { chooseOrg } from "@/lib/org-choice";
import { readValue, STORED, writeValue } from "@/lib/storage";
import { useSession } from "./session";

export interface OrgState {
  /** The current organization (always set inside the app's screens). */
  orgId: string;
  org: OrgSummary | null;
  orgs: OrgSummary[];
  setOrgId: (orgId: string) => void;
}

interface OrgGate {
  /** Loading `me` or the remembered choice. */
  loading: boolean;
  /** Signed in but in no organization yet. */
  none: boolean;
  /**
   * `me` failed and nothing is cached (the server is down or out of reach): not "no organization", which would
   * open the first run.
   */
  unreachable: boolean;
  /** Asks for `me` again (the unreachable screen's "Tentar de novo"). */
  retry: () => Promise<unknown>;
  state: OrgState | null;
  /** Makes an organization the current one (an invitation accepted, a workspace created in the first run). */
  choose: (orgId: string) => void;
}

/** How many times `me` is asked again while signed in and still null, and how long apart (ms). */
const STALE_TRIES = 3;
const STALE_RETRY_MS = 700;

const OrgContext = createContext<OrgGate>({
  loading: true,
  none: false,
  unreachable: false,
  retry: async () => {},
  state: null,
  choose: () => {},
});

/** The current organization: remembered in SecureStore, switched by `setOrgId` (and by a push's `orgId`). */
export function OrgProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const session = useSession();
  const [remembered, setRemembered] = useState<string | null | undefined>(undefined);

  // `me` answered while signed out (null) a moment before the session arrived is not "no organization": that
  // opened the first run over someone with workspaces (signing in with the web's QR code). It is still loading
  // until `me` is asked again with the session (SessionProvider does it; here a few more times while it stays
  // null, then the session itself is read again, and one the server no longer knows ends there).
  const stale = session.signedIn && me.data === null;
  const tries = useRef(0);
  const { refetch } = me;
  const { refresh } = session;
  useEffect(() => {
    if (!stale) {
      tries.current = 0;
      return;
    }
    if (me.isFetching || tries.current >= STALE_TRIES) return;
    const timer = setTimeout(() => {
      tries.current += 1;
      void refetch().then((r) => {
        if (r.data === null && tries.current >= STALE_TRIES) void refresh();
      });
    }, STALE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [stale, me.isFetching, refetch, refresh]);

  useEffect(() => {
    let alive = true;
    readValue(STORED.org).then((v) => {
      if (alive) setRemembered(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setOrgId = useCallback((orgId: string) => {
    setRemembered(orgId);
    void writeValue(STORED.org, orgId);
  }, []);

  const orgs = me.data?.organizations ?? [];
  const orgId = remembered === undefined ? null : chooseOrg(orgs, remembered);
  const unreachable = me.isError && me.data === undefined;
  const retry = me.refetch;
  const value = useMemo<OrgGate>(() => {
    const base = { unreachable, retry, choose: setOrgId };
    const loading = me.isPending || remembered === undefined || stale;
    if (loading || unreachable) return { ...base, loading, none: false, state: null };
    if (!orgId) return { ...base, loading: false, none: true, state: null };
    return {
      ...base,
      loading: false,
      none: false,
      state: { orgId, org: orgs.find((o) => o.id === orgId) ?? null, orgs, setOrgId },
    };
  }, [me.isPending, stale, unreachable, retry, remembered, orgId, orgs, setOrgId]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

/** For the root gate: whether the organization is known yet. */
export const useOrgGate = () => useContext(OrgContext);

/** The current organization. Only inside the app's screens (the gate guarantees one). */
export function useOrg(): OrgState {
  const { state } = useContext(OrgContext);
  if (!state) throw new Error("useOrg is only available once an organization is chosen");
  return state;
}

/** Like `useOrg`, but null instead of throwing (providers that also run outside the app's screens). */
export const useOrgMaybe = (): OrgState | null => useContext(OrgContext).state;
