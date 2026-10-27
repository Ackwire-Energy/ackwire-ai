import type { AiStatus, AppNotification } from "@agenteschat/client";
import { cacheNotification, keys, useApi } from "@agenteschat/client";
import { type OpenTarget, opensConnectAi, openTarget } from "@agenteschat/client/lib/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { requestBrowserCard } from "@/components/browser/open";
import { useConnectAi } from "@/components/ConnectAi";
import { LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { fallbackTarget, type PushOpenData, setPushOpenHandler } from "@/lib/push-open";

/**
 * Opening a notification, wherever the click was: the inbox's "Abrir" and a click on a browser notification
 * (ADR 0071) go to the same place, through `openTarget`.
 */

type Navigate = ReturnType<typeof useNavigate>;

/** Moves to where a notification opens, in its workspace (`replace`: instead of the page this tab is on). */
export function goToTarget(navigate: Navigate, orgId: string, target: OpenTarget, replace = false) {
  switch (target.to) {
    case "/org/$orgId/threads/$threadId":
      return void navigate({ to: target.to, params: { orgId, ...target.params }, replace });
    case "/org/$orgId/c/$channelId":
      return void navigate({
        to: target.to,
        params: { orgId, ...target.params },
        search: target.search ?? {},
        replace,
      });
    case "/org/$orgId/dm/agent/$agentId":
      return void navigate({ to: target.to, params: { orgId, ...target.params }, replace });
    case "/org/$orgId/dm/person/$userId":
      return void navigate({ to: target.to, params: { orgId, ...target.params }, replace });
    case "/org/$orgId/issues/$number":
      return void navigate({ to: target.to, params: { orgId, ...target.params }, replace });
    case "/org/$orgId/forum/$topicId":
      return void navigate({ to: target.to, params: { orgId, ...target.params }, replace });
    case "/org/$orgId/threads":
      return void navigate({ to: target.to, params: { orgId }, search: target.search, replace });
    case "/org/$orgId/settings/computers/$machineId":
      return void navigate({ to: target.to, params: { orgId, ...target.params }, replace });
    case "/org/$orgId/settings/$section":
      return void navigate({ to: target.to, params: { orgId, ...target.params }, search: {}, replace });
    case "/org/$orgId/routines":
      // A routine's trouble opens it in Rotinas, its state and fix in view.
      return void navigate({ to: target.to, params: { orgId }, search: target.search ?? {}, replace });
    default:
      return void navigate({ to: target.to, params: { orgId }, replace });
  }
}

/** The inbox itself, with nothing to open. */
function goToInbox(navigate: Navigate, orgId: string, replace: boolean) {
  void navigate({ to: "/org/$orgId/notifications", params: { orgId }, search: {}, replace });
}

/** What opening did: moved to a page, opened a dialog over this one, or found nowhere to go. */
export type Opened = "page" | "dialog" | null;

/**
 * Opens a notification in the workspace on screen (`orgId`): "Conectar uma IA" for a ready computer whose agents
 * have no AI (`ai`: the workspace's AI status), else its page, with an agent's help request opening its card.
 * Marking it read is the caller's (the inbox's own action, or the read that fetched it).
 */
export function useNotificationOpener() {
  const navigate = useNavigate();
  const connect = useConnectAi();
  return useCallback(
    (n: AppNotification, orgId: string, options: { ai?: AiStatus; replace?: boolean } = {}): Opened => {
      if (connect && opensConnectAi(n, options.ai)) {
        connect.open({ ready: true });
        return "dialog";
      }
      const target = openTarget(n);
      if (!target) return null;
      // An agent asked for help in its browser: its card opens there, in control (no page of its own).
      if (n.kind === "browser_handoff" && n.source.handoffId) requestBrowserCard({ handoffId: n.source.handoffId });
      goToTarget(navigate, orgId, target, options.replace ?? false);
      return "page";
    },
    [navigate, connect],
  );
}

/**
 * Opens a notification a push named, in the workspace on screen: reads it the way the inbox's "Abrir" marks it
 * (the read answers the whole notification), then goes where the inbox goes. Gone or unreadable: the place the
 * push itself names (`fallbackTarget`), else the inbox.
 */
export function useOpenPushed() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = useNotificationOpener();
  return useCallback(
    async (data: PushOpenData, replace: boolean): Promise<void> => {
      const { orgId, notificationId } = data;
      const n = await api.notifications.read(orgId, notificationId, true).catch(() => null);
      if (n) {
        cacheNotification(qc, orgId, n);
        const ai =
          n.kind === "computer_ready"
            ? await qc
                .fetchQuery({
                  queryKey: keys.aiStatus(orgId),
                  queryFn: () => api.agents.aiStatus(orgId),
                  staleTime: 30_000,
                })
                .catch(() => undefined)
            : undefined;
        const opened = open(n, orgId, { ai, replace });
        if (opened === "page") return;
        // A dialog over the inbox, or nowhere of its own: the inbox (without `?open`, so a reload doesn't redo it).
        if (opened === null || replace) goToInbox(navigate, orgId, replace);
        return;
      }
      const target = fallbackTarget(data);
      if (target) goToTarget(navigate, orgId, target, replace);
      else goToInbox(navigate, orgId, replace);
    },
    [api, qc, navigate, open],
  );
}

/**
 * In the workspace shell: a click on a browser notification while this tab is open (`listenForPushOpens`).
 * One of this workspace opens at once, with no stop at the inbox; one of another workspace goes to that
 * workspace's inbox with `?open=`, which opens it there (`OpeningNotification`).
 */
export function PushOpens() {
  const { org } = useOrg();
  const navigate = useNavigate();
  const openPushed = useOpenPushed();
  useEffect(
    () =>
      setPushOpenHandler((click) => {
        const data = click.data;
        // A push that names no notification: the tab just goes to its address.
        if (!data) return false;
        if (data.orgId !== org.id) {
          void navigate({
            to: "/org/$orgId/notifications",
            params: { orgId: data.orgId },
            search: { open: data.notificationId },
          });
          return true;
        }
        void openPushed(data, false);
        return true;
      }),
    [org.id, navigate, openPushed],
  );
  return null;
}

/**
 * The inbox opened with `?open=<id>` (a click on a browser notification with no tab of the app open, public/sw.js):
 * opens that notification in place of this page, as the inbox would; the page shows loading meanwhile.
 */
export function OpeningNotification({ id }: { id: string }) {
  const { org } = useOrg();
  const openPushed = useOpenPushed();
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (started.current === id) return;
    started.current = id;
    void openPushed({ orgId: org.id, notificationId: id, kind: null }, true);
  }, [id, org.id, openPushed]);
  return <LoadingPage />;
}
