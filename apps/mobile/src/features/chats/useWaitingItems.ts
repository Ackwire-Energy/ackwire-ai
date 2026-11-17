import { useMissionList, useNotifications } from "@agenteschat/client";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOrgId } from "../shared/hooks";
import { useWaitingApprovals } from "../shared/queries";
import { missionsWaiting, openQuestions } from "./logic";
import { type WaitingItem, waitingItems } from "./waiting";

/**
 * Everything waiting on you, in Atividade's order (requests, missions, questions): what the tab's badge counts and
 * an agent's row on Conversas says. A request's title is in words ("Salvar um rascunho de resposta para…", "Ver
 * stack trace do evento"), never the tool's raw name.
 */
export function useWaitingItems(): { items: WaitingItem[]; refetch: () => Promise<unknown> } {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const approvals = useWaitingApprovals();
  const missions = useMissionList(orgId, { status: "waiting_you" });
  const inbox = useNotifications(orgId, "waiting");
  const items = useMemo(
    () =>
      waitingItems({
        approvals: approvals.map((a) => ({ ...a, title: approvalTitle(t, a) })),
        missions: missionsWaiting(missions.data?.missions ?? []),
        questions: openQuestions(inbox.data?.pages.flatMap((p) => p.items) ?? []),
      }),
    [approvals, missions.data, inbox.data, t],
  );
  return { items, refetch: () => Promise.allSettled([missions.refetch(), inbox.refetch()]) };
}
