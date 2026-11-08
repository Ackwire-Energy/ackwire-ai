import { useAgents, useNotificationCount, useWebPushKey } from "@agenteschat/client";
import {
  exampleSenders,
  MAX_PUSH_OFFERS,
  type PushOfferMoment,
  type PushPermissionLike,
  pushOfferDue,
  pushOffersFrom,
} from "@agenteschat/client/lib/push-offer";
import { Button, Dialog, DialogBody } from "@agenteschat/ui";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import { typingInField } from "@/lib/keys";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import {
  canOfferWebPush,
  disableWebPush,
  enableWebPush,
  readPushEnvironment,
  readWebPushState,
  refreshWebPush,
  setStalePushSweeper,
  sweepStalePushes,
  type WebPushState,
} from "@/lib/web-push";

/** Read once per page load: what the browser offers doesn't change while it is open. */
let offeredHere: boolean | undefined;
/** Who the server last heard this browser's subscription for, in which language (`useWebPushRefresh`). */
let refreshedFor: string | null = null;
const offered = () => {
  offeredHere ??= canOfferWebPush(readPushEnvironment());
  return offeredHere;
};

/**
 * "Avisos neste navegador" (ADR 0071): this browser's state and its switch, in Configurações › Notificações. `shown`
 * only where this browser can take notifications and the server sends them. Nothing asks for permission until the
 * person flips it.
 */
export function useBrowserNotices() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const here = offered();
  const publicKey = useWebPushKey(here).data;
  const [state, setState] = useState<WebPushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!here || publicKey === undefined) return;
    let live = true;
    void readWebPushState(publicKey).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [here, publicKey]);

  const change = (on: boolean) => {
    if (busy || !publicKey) return;
    setBusy(true);
    // The person chose here: the dialog never asks again in this browser.
    storage.set(STORAGE_KEYS.pushOffers, String(MAX_PUSH_OFFERS));
    // Straight from the click: the browser shows its permission prompt only during the person's gesture.
    const run = on ? enableWebPush(api, publicKey, i18n.language) : disableWebPush(api);
    run
      .then((next) => {
        // Chrome's quieter prompts may keep the request as a crossed-out bell in the address bar, with no answer:
        // without a word here the switch would just go back off.
        if (on && next === "default") toast.show(t("shell.browserNoticesUnanswered"));
        setState(next);
      })
      .catch(() => {
        toast.show(t("shell.browserNoticesFailed"), "error");
        return readWebPushState(publicKey).then(setState);
      })
      .finally(() => setBusy(false));
  };

  const shown = here && Boolean(publicKey) && state !== null && state !== "unsupported" && state !== "off-by-server";
  return { shown, on: state === "subscribed", blocked: state === "denied", busy, change };
}

/**
 * On opening a workspace: a browser already on tells the server again, quietly (it keeps it, and it moves
 * to whoever is signed in now). Asks the person nothing.
 */
export function useWebPushRefresh(userId: string) {
  const api = useApi();
  const { i18n } = useTranslation();
  const locale = i18n.language;
  useEffect(() => {
    // Once per page load for each person and language: the route is rate limited.
    const what = `${userId}:${locale}`;
    if (!userId || !offered() || refreshedFor === what) return;
    refreshedFor = what;
    void refreshWebPush(api, locale);
  }, [api, userId, locale]);
}

/**
 * Clear on read (ADR 0071): the notifications this browser still shows for what the person already read,
 * finished or snoozed elsewhere close on opening the app, whenever the tab comes back into view, and after the
 * badge drops (the realtime handler asks for it, `requestStalePushSweep`). Quiet, and nothing at all where
 * notifications aren't on in this browser.
 */
export function useWebPushClear() {
  const api = useApi();
  useEffect(() => {
    if (!offered()) return;
    const sweep = () => sweepStalePushes(api);
    setStalePushSweeper(sweep);
    void sweep();
    const onVisible = () => {
      if (document.visibilityState === "visible") void sweep();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      setStalePushSweeper(null);
    };
  }, [api]);
}

/** The examples, top to bottom, as the phone's sheet shows them: fading a little as they stack. */
const EXAMPLES = [
  { key: "approval", minutes: 0, opacity: 1 },
  { key: "finished", minutes: 2, opacity: 0.92 },
  { key: "mention", minutes: 9, opacity: 0.8 },
] as const;

/** Pages where the dialog never opens by itself: the focused flows (the web's home is a channel, so channels count). */
const QUIET_PAGE = /\/(onboarding|agents\/new)\/?$/;

/** Someone typing (the composer, a field) isn't interrupted: the dialog waits for the next page. */
const typing = () => typeof document !== "undefined" && typingInField(document.activeElement);

const promptState = (): PushPermissionLike => {
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission === "default" ? "undetermined" : Notification.permission;
};

/**
 * Our notifications dialog, before the browser's prompt (ADR 0071), the phone's sheet on the web: three
 * notifications as they will arrive, what they are for, "Ativar avisos" (the browser's prompt, from that click)
 * and "Agora não". Opens by itself once when the workspace has agents, and once more at the first request
 * waiting on the person (`pushOfferDue`), never over someone typing, never where this browser can't take them.
 */
export function WebPushAsk() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const { org } = useOrg();
  const here = offered();
  const publicKey = useWebPushKey(here).data;
  const agents = useAgents(org.id).data;
  const waiting = useNotificationCount(org.id).data?.waiting ?? 0;
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [offers, setOffers] = useState(() => pushOffersFrom(storage.get(STORAGE_KEYS.pushOffers), false));
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);

  const ready = here && Boolean(publicKey);
  const moment: PushOfferMoment | null = !ready
    ? null
    : waiting > 0 && offers === 1
      ? "approval"
      : (agents?.length ?? 0) > 0
        ? "home"
        : null;

  useEffect(() => {
    // Checked again on each page: moving on is when someone who was typing can be asked.
    if (!moment || open || QUIET_PAGE.test(path) || typing()) return;
    if (!pushOfferDue({ permission: promptState(), turnedOff: false, offers }, moment)) return;
    const next = offers + 1;
    storage.set(STORAGE_KEYS.pushOffers, String(next));
    setOffers(next);
    setOpen(true);
  }, [moment, offers, open, path]);

  if (!publicKey) return null;
  const senders = exampleSenders(
    (agents ?? []).map((a) => a.name),
    t("webPushAsk.someone"),
  );

  const turnOn = () => {
    if (asking) return;
    setAsking(true);
    // Straight from the click: the browser shows its prompt only during the person's gesture.
    enableWebPush(api, publicKey, i18n.language)
      .then((state) => {
        if (state === "subscribed") toast.show(t("webPushAsk.done"));
        // Chrome's quieter prompts may keep it as a crossed-out bell by the address, with no answer.
        else if (state === "default") toast.show(t("shell.browserNoticesUnanswered"));
      })
      .catch(() => toast.show(t("webPushAsk.failed"), "error"))
      .finally(() => {
        setAsking(false);
        setOpen(false);
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !asking && setOpen(false)}
      title={t("webPushAsk.title")}
      description={t("webPushAsk.text")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody className="web-push-ask">
        <ul className="web-push-ask__examples" aria-label={t("webPushAsk.examples")}>
          {EXAMPLES.map((x, i) => (
            <li key={x.key} className="web-push-ask__example" style={{ opacity: x.opacity }}>
              <img src="/email/mark.png" alt="" width={32} height={32} />
              <span className="web-push-ask__text">
                <span className="web-push-ask__top">
                  <strong>{t(`webPushAsk.${x.key}.title`, { name: senders[i] })}</strong>
                  <span>{x.minutes === 0 ? t("webPushAsk.now") : t("webPushAsk.minutes", { n: x.minutes })}</span>
                </span>
                <span className="web-push-ask__body">{t(`webPushAsk.${x.key}.body`)}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="web-push-ask__acts">
          <Button variant="primary" icon="bell" loading={asking} onClick={turnOn}>
            {t("webPushAsk.on")}
          </Button>
          <Button variant="ghost" disabled={asking} onClick={() => setOpen(false)}>
            {t("webPushAsk.later")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  );
}
