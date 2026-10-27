import { type AiStatus, keys, useApi } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { hrefForPush } from "@/features/links/logic";
import {
  alreadyAskedForPush,
  configureForegroundPush,
  ensureAndroidChannel,
  pushPermission,
  pushTurnedOff,
  registerForPush,
} from "@/lib/push";
import { readPushData } from "@/lib/push-payload";
import { useOrgMaybe } from "./org";

/** How long after sign-in the app waits, with the person using it, before asking for push (ms). */
const CALM_MS = 20_000;

interface PushApi {
  /** Ask now (a screen with a good reason, e.g. after the first request to approve). */
  ask: () => Promise<boolean>;
}

const PushContext = createContext<PushApi>({ ask: async () => false });

configureForegroundPush();

/** Notifications already opened (the launch one must not reopen when the provider remounts). */
const opened = new Set<string>();

/**
 * Push for a signed-in person with an organization: registers silently when already allowed, asks once
 * at a calm moment (never at launch), and opens what a tapped notification is about.
 */
export function PushProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const org = useOrgMaybe();
  const ready = Boolean(org);
  const setOrgId = org?.setOrgId;
  const setOrgRef = useRef(setOrgId);
  setOrgRef.current = setOrgId;
  const locale = i18n.language;
  const api = useApi();
  const qc = useQueryClient();

  const ask = useCallback(() => registerForPush({ ask: true, locale }), [locale]);

  // Register (or ask once, later, at a calm moment).
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    void ensureAndroidChannel(t("mobile.push.channel"), t("mobile.push.channelDescription"));
    void (async () => {
      const permission = await pushPermission();
      if (!alive || (await pushTurnedOff())) return;
      if (permission === "granted") {
        await registerForPush({ ask: false, locale });
        return;
      }
      if (permission === "undetermined" && !(await alreadyAskedForPush())) {
        timer = setTimeout(() => {
          if (alive && AppState.currentState === "active") void registerForPush({ ask: true, locale });
        }, CALM_MS);
      }
    })();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [ready, locale, t]);

  // A tapped notification opens its screen (after switching to its organization).
  useEffect(() => {
    if (!ready) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (opened.has(id)) return;
      opened.add(id);
      const data = readPushData(response.notification.request.content.data);
      const orgId = data.orgId;
      if (orgId) setOrgRef.current?.(orgId);
      // The computer being ready opens Connect an AI while no agent has one: its AI status is asked first.
      const ai: Promise<AiStatus | undefined> =
        data.kind === "computer_ready" && orgId
          ? qc
              .fetchQuery({
                queryKey: keys.aiStatus(orgId),
                queryFn: () => api.agents.aiStatus(orgId),
                staleTime: 30_000,
              })
              .catch(() => undefined)
          : Promise.resolve(undefined);
      void ai.then((status) => {
        const href = hrefForPush(data, status);
        setTimeout(() => router.push(href), 0);
      });
    };
    try {
      open(Notifications.getLastNotificationResponse());
    } catch {
      // No launch notification.
    }
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [ready, api, qc]);

  const value = useMemo(() => ({ ask }), [ask]);
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}

/** `usePush().ask()`: ask for notifications now, from a screen with a good reason. */
export const usePush = () => useContext(PushContext);
