import { useWebPushKey } from "@agenteschat/client";
import { MenuOverlayRow, Switch } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
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
 * "Avisos neste navegador" in the account menu (ADR 0071): one switch. Shown only where this browser can take
 * notifications and the server sends them; blocked by the browser, the switch is off and the line under it
 * says where to allow them again. Nothing asks for permission until the person flips it.
 */
export function BrowserNoticesRow() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const here = offered();
  const key = useWebPushKey(here);
  const publicKey = key.data;
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

  if (!here || !publicKey || state === null || state === "unsupported" || state === "off-by-server") return null;

  const change = (on: boolean) => {
    if (busy) return;
    setBusy(true);
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

  const blocked = state === "denied";
  return (
    <MenuOverlayRow
      icon="bell"
      label={t("shell.browserNotices")}
      description={blocked ? t("shell.browserNoticesBlocked") : t("shell.browserNoticesHint")}
      descriptionId="browser-notices-desc"
    >
      <Switch
        checked={state === "subscribed"}
        onCheckedChange={change}
        disabled={blocked || busy}
        aria-label={t("shell.browserNotices")}
        aria-describedby="browser-notices-desc"
      />
    </MenuOverlayRow>
  );
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
