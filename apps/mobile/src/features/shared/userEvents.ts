import {
  type Approval,
  applyNotificationEvent,
  cacheApproval,
  isNotificationEvent,
  keys,
  refreshMission,
} from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useConnection, useOrgId } from "./hooks";

/**
 * Events for the signed-in person, whatever screen is open: requests they
 * can decide, the inbox and its badge (D46), missions waiting on them. Keeps
 * Início, Atividade and the tab badges live.
 */
export function useUserEvents() {
  const connection = useConnection();
  const orgId = useOrgId();
  const qc = useQueryClient();
  useEffect(() => {
    if (!connection) return;
    const offUser = connection.onUserEvent((event) => {
      if ((event.type === "approval.created" || event.type === "approval.decided") && "approval" in event) {
        cacheApproval(qc, orgId, event.approval as Approval);
        void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
      }
      if (isNotificationEvent(event)) applyNotificationEvent(qc, orgId, event);
      if (event.type.startsWith("mission.") && "missionId" in event && typeof event.missionId === "string")
        refreshMission(qc, orgId, event.missionId);
    });
    // Missed while offline: the inbox, its badge and the requests catch up.
    const offReconnect = connection.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: keys.notifications(orgId) });
      void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
    });
    return () => {
      offUser();
      offReconnect();
    };
  }, [connection, orgId, qc]);
}
