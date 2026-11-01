import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type DetailsItem, OpenDetailsContext } from "@/components/details-link";
import { ApprovalDetailsDialog } from "@/pages/ApprovalsPage";
import { RoutineDetailsDialog } from "@/pages/RoutinesPage";

/**
 * One details dialog for the workspace, over the page the person is on: a `DetailsLink` opens it in place and
 * the page underneath keeps its place. Like the agent panel, it lives outside the URL; going to another page
 * (a run's "Abrir na conversa") closes it.
 */
export function DetailsHost({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<DetailsItem | null>(null);
  const close = useCallback(() => setItem(null), []);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every change of page
  useEffect(() => setItem(null), [path]);
  return (
    <OpenDetailsContext.Provider value={setItem}>
      {children}
      {item?.kind === "routine" && <RoutineDetailsDialog key={item.id} routineId={item.id} onClose={close} />}
      {item?.kind === "approval" && <ApprovalDetailsDialog key={item.id} approvalId={item.id} onClose={close} />}
    </OpenDetailsContext.Provider>
  );
}
