import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useCatalog, useConnections } from "@/api/queries";
import { type ScopeGroup, scopeGroups } from "@/lib/scopes";

/** Built-in scopes plus one group per active connection of the org. */
export function useScopeGroups(orgId: string): ScopeGroup[] | undefined {
  const { t } = useTranslation();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  return useMemo(
    () =>
      catalog.data && connections.data
        ? scopeGroups(t, catalog.data, connections.data, { name: t("agent.builtinName"), note: t("agent.builtinNote") })
        : undefined,
    [catalog.data, connections.data, t],
  );
}
