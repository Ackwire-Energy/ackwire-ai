import { type OrgSummary, useMe } from "@agenteschat/client";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { chooseOrg } from "@/lib/org-choice";
import { readValue, STORED, writeValue } from "@/lib/storage";

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
  state: OrgState | null;
  /** Makes an organization the current one (an invitation accepted, a workspace created in the first run). */
  choose: (orgId: string) => void;
}

const OrgContext = createContext<OrgGate>({ loading: true, none: false, state: null, choose: () => {} });

/** The current organization: remembered in SecureStore, switched by `setOrgId` (and by a push's `orgId`). */
export function OrgProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const [remembered, setRemembered] = useState<string | null | undefined>(undefined);

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
  const value = useMemo<OrgGate>(() => {
    const loading = me.isPending || remembered === undefined;
    if (loading) return { loading, none: false, state: null, choose: setOrgId };
    if (!orgId) return { loading: false, none: true, state: null, choose: setOrgId };
    return {
      loading: false,
      none: false,
      state: { orgId, org: orgs.find((o) => o.id === orgId) ?? null, orgs, setOrgId },
      choose: setOrgId,
    };
  }, [me.isPending, remembered, orgId, orgs, setOrgId]);

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
