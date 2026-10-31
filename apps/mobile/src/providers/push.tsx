import { type AiStatus, keys, type Me, useApi } from "@agenteschat/client";
import { type PushOfferMoment, pushOfferDue, pushOffersFrom } from "@agenteschat/client/lib/push-offer";
import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { hrefForPush } from "@/features/links/logic";
import { pushOpens } from "@/lib/org-choice";
import {
  configureForegroundPush,
  ensureAndroidChannel,
  type PushPermission,
  pushPermission,
  pushTurnedOff,
  registerForPush,
} from "@/lib/push";
import { readPushData } from "@/lib/push-payload";
import { readValueSync, STORED, writeValue } from "@/lib/storage";
import { useOrgMaybe } from "./org";

interface PushApi {
  /** The system's prompt now (from our sheet, or Você › Avisos); whether this phone got registered. */
  ask: () => Promise<boolean>;
  /** Whether our sheet should open by itself at each moment (Conversas decides when it shows). */
  offer: Record<PushOfferMoment, boolean>;
  /** Our sheet opened by itself: counted, so it doesn't open again for the same moment. */
  markOffered: () => void;
}

const PushContext = createContext<PushApi>({
  ask: async () => false,
  offer: { home: false, approval: false },
  markOffered: () => {},
});

configureForegroundPush();

/** Notifications already opened (the launch one must not reopen when the provider remounts). */
const opened = new Set<string>();

/**
 * Push for a signed-in person with an organization: registers silently when already allowed, says when our
 * sheet should come before the system's prompt (`@agenteschat/client/lib/push-offer`; never at launch, never inside a
 * conversation: Conversas opens it), and opens what a tapped notification is about.
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
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [turnedOff, setTurnedOff] = useState(false);
  const [offers, setOffers] = useState(() =>
    pushOffersFrom(readValueSync(STORED.pushOffers), readValueSync(STORED.pushAsked) === "1"),
  );

  const ask = useCallback(async () => {
    const ok = await registerForPush({ ask: true, locale });
    setPermission(await pushPermission());
    setTurnedOff(await pushTurnedOff());
    return ok;
  }, [locale]);

  const markOffered = useCallback(() => {
    setOffers((n) => n + 1);
  }, []);
  useEffect(() => {
    void writeValue(STORED.pushOffers, String(offers));
  }, [offers]);

  // Register when already allowed; read what the phone allows again when the app comes back to the front
  // (Ajustes may have changed it), registering if it became allowed there.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let was: PushPermission | null = null;
    void ensureAndroidChannel(t("mobile.push.channel"), t("mobile.push.channelDescription"));
    const check = async () => {
      const now = await pushPermission();
      const off = await pushTurnedOff();
      if (!alive) return;
      setPermission(now);
      setTurnedOff(off);
      if (now === "granted" && was !== "granted" && !off) await registerForPush({ ask: false, locale });
      was = now;
    };
    void check();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => {
      alive = false;
      sub.remove();
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
      if (orgId && !pushOpens(qc.getQueryData<Me | null>(keys.me)?.organizations ?? [], orgId)) return;
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

  const value = useMemo<PushApi>(() => {
    const state = { permission, turnedOff, offers };
    return {
      ask,
      offer: { home: pushOfferDue(state, "home"), approval: pushOfferDue(state, "approval") },
      markOffered,
    };
  }, [ask, markOffered, permission, turnedOff, offers]);
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}

/** `usePush()`: the system's prompt (`ask`) and when our sheet should open by itself (`offer`). */
export const usePush = () => useContext(PushContext);
