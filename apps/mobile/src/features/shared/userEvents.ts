import {
  type Approval,
  applyNotificationEvent,
  cacheApproval,
  isNotificationEvent,
  keys,
  refreshMission,
  type ThreadFollowEvent,
  type ThreadInfo,
} from "@agenteschat/client";
import { isOutageEvent } from "@agenteschat/client/lib/machine-outages";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { outagesKey } from "../outages/queries";
import { useConnection, useOrgId } from "./hooks";

/**
 * Events for the signed-in person, whatever screen is open: requests they
 * can decide, the inbox and its badge (D46), missions waiting on them, computers going offline or back. Keeps
 * Início, Atividade and the tab badges live, and "Seguir" in step across
 * devices.
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
      if (isNotificationEvent(event)) {
        applyNotificationEvent(qc, orgId, event);
        // Something new reached you somewhere: the conversation list's unread and last lines.
        if (event.type === "notification.upserted") {
          void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
          void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
        }
      }
      // "Seguir" changed on one of your devices.
      if (event.type === "thread.follow" && "threadId" in event) {
        const follow = event as ThreadFollowEvent;
        qc.setQueryData<ThreadInfo>(keys.threadInfo(orgId, follow.threadId), (t) =>
          t ? { ...t, following: follow.following } : t,
        );
        void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
      }
      // Org events: a computer went offline or came back, agents moved off one ("Computador desconectado").
      if (isOutageEvent(event)) void qc.invalidateQueries({ queryKey: outagesKey(orgId) });
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
