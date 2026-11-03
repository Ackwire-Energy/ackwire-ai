import {
  type Approval,
  applyComputerEvent,
  applyMachineEvent,
  applyNotificationEvent,
  applyUnreadEvent,
  applyWorkspaceEvent,
  cacheApproval,
  isNotificationEvent,
  keys,
  refreshMission,
  type ThreadFollowEvent,
  type ThreadInfo,
} from "@agenteschat/client";
import { playSound, soundForNotification } from "@agenteschat/client/lib/sounds";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { feedIsland, island } from "../island/island";
import { useConnection, useOrgId } from "./hooks";

/**
 * Events for the signed-in person, whatever screen is open: requests they
 * can decide, the inbox and its badge, missions waiting on them, computers going offline or back. Keeps
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
        // The island at the top (ADR 0071 §9): what reaches me while the app is open, and what I settled elsewhere.
        feedIsland(event);
        // Something new reached you somewhere: the conversation list's unread and last lines.
        if (event.type === "notification.upserted") {
          void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
          void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
          // Its sound (ADR 0070); the push covers the app in the background.
          const sound = soundForNotification(event.notification, AppState.currentState !== "active");
          if (sound) playSound(sound);
        }
      }
      // Unread marks: a message where you are, and your reads and mutes from any device.
      applyUnreadEvent(qc, orgId, event);
      // "Seguir" changed on one of your devices.
      if (event.type === "thread.follow" && "threadId" in event) {
        const follow = event as ThreadFollowEvent;
        qc.setQueryData<ThreadInfo>(keys.threadInfo(orgId, follow.threadId), (t) =>
          t ? { ...t, following: follow.following } : t,
        );
        void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
      }
      // Org events about the computers, as on the web: one went offline or came back (and the agents waiting for
      // it, "Computador desconectado"), paused, renamed, removed, its agents moved; an agent switched computers.
      applyMachineEvent(qc, orgId, event);
      applyComputerEvent(qc, orgId, event);
      // The workspace's standing (the suspended screen comes and goes), its own computer on its way, and the groups
      // of agents (Agentes' sections).
      applyWorkspaceEvent(qc, orgId, event);
      // Org event: someone changed the task board's columns. Deleting one moves its tasks, so the
      // tasks refresh too (the columns live under the same key).
      if (event.type === "issue.columns") void qc.invalidateQueries({ queryKey: keys.issues(orgId) });
      if (event.type.startsWith("mission.") && "missionId" in event && typeof event.missionId === "string")
        refreshMission(qc, orgId, event.missionId);
    });
    // Missed while offline: the inbox, its badge and the requests catch up.
    const offReconnect = connection.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: keys.notifications(orgId) });
      void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
      // The organization's standing may have changed meanwhile (the suspended screen), and so may the workspace's
      // computer on its way, the computers and the agents' screens.
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: keys.computerSetup(orgId) });
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
      void qc.invalidateQueries({ queryKey: keys.agentDesktops(orgId) });
      // The groups of agents someone changed meanwhile.
      void qc.invalidateQueries({ queryKey: keys.agentGroups(orgId) });
    });
    return () => {
      offUser();
      offReconnect();
      // In the background, or another workspace: its notices go (the inbox keeps them).
      island.clear();
    };
  }, [connection, orgId, qc]);
}
