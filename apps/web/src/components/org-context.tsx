import type { Me, OrgSummary } from "@agenteschat/client";
import { createContext, type ReactNode, useContext } from "react";

interface OrgContextValue {
  org: OrgSummary;
  me: Me;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ org, me, children }: OrgContextValue & { children: ReactNode }) {
  return <OrgContext.Provider value={{ org, me }}>{children}</OrgContext.Provider>;
}

/** The current organization and the signed-in person, inside `/org/$orgId/*`. */
export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext);
  if (!value) throw new Error("useOrg must be used inside an organization route");
  return value;
}
