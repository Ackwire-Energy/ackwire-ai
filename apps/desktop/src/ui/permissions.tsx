import { Button, Chip, Icon, type IconName } from "@agenteschat/ui";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost } from "../app";
import {
  type Asked,
  allOn,
  askedIn,
  type Grants,
  MAC_ASKED_PREF,
  MAC_PERMISSIONS,
  type MacPermission,
  readGrants,
  withAsked,
} from "../control/permissions";
import { readPref, usePending, writePref } from "../hooks";
import type { Host } from "../host/types";
import { PrefCard, PrefRow } from "./settings";
import { useToast } from "./Toast";

const ICON: Record<MacPermission, IconName> = {
  screen: "image",
  desktop: "computer",
  documents: "document",
  downloads: "download",
};

/** This Mac's permissions now, nothing asked. */
export async function macGrants(host: Host): Promise<Grants> {
  const { version } = await host.appInfo();
  return readGrants(host, askedIn(readPref<Asked | null>(MAC_ASKED_PREF, null), version));
}

/** A pairing on a Mac goes on to Prepare this Mac while any permission isn't on. */
export const needsPrepare = async (host: Host) => host.platform === "mac" && !allOn(await macGrants(host));

export interface MacGrants {
  grants: Grants | null;
  pending: MacPermission | null;
  /** Allow (the system's prompt) the first time, System Settings once it was refused. */
  ask: (p: MacPermission) => Promise<void>;
}

/**
 * The permissions, read again whenever the window comes back to the front (from System Settings). `beforeScreen`: just
 * before Screen Recording is asked, which may end with macOS quitting the app.
 */
export function useMacGrants(beforeScreen?: () => Promise<void>): MacGrants {
  const { t } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const [grants, setGrants] = useState<Grants | null>(null);
  const [pending, run] = usePending<MacPermission>();
  const refresh = useCallback(
    () =>
      macGrants(host)
        .then(setGrants)
        .catch(() => {}),
    [host],
  );
  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const ask = (p: MacPermission) =>
    run(p, async () => {
      try {
        if (p === "screen") await beforeScreen?.();
        if (grants?.[p] === "off") await host.openPrivacy(p === "screen" ? "screen" : "files");
        else {
          const { version } = await host.appInfo();
          writePref(MAC_ASKED_PREF, withAsked(readPref<Asked | null>(MAC_ASKED_PREF, null), version, p));
          if (p === "screen") await host.requestScreenAccess();
          else await host.folderAccess(p);
        }
      } catch {
        toast(t("desktop.common.error"), "alert");
      }
      await refresh();
    });
  return { grants, pending, ask };
}

/**
 * The permissions as rows: what each lets agents do, its state, one button. Under them, once Screen Recording was
 * asked, what to do when macOS asks to quit and reopen the app; `resumed`: it just did, so the line says it took effect.
 */
export function MacPermissionCard({ mac, resumed = false }: { mac: MacGrants; resumed?: boolean }) {
  const { t } = useTranslation();
  const { grants, pending, ask } = mac;
  // Opened again by macOS: Preferences starts at its top, so the card the person left comes back into view.
  const seen = useCallback(
    (el: HTMLElement | null) => {
      if (resumed) el?.scrollIntoView?.({ block: "nearest" });
    },
    [resumed],
  );
  const line =
    grants?.screen === "on" && resumed ? (
      <p ref={seen} className="dk-under-card dk-help ac-iconline" aria-live="polite">
        <Icon name="check" size={14} />
        <span>{t("desktop.prepare.tookEffect")}</span>
      </p>
    ) : grants?.screen === "off" ? (
      <p ref={seen} className="dk-under-card dk-help">
        {t("desktop.prepare.reopen")}
      </p>
    ) : null;
  return (
    <>
      <PrefCard>
        {MAC_PERMISSIONS.map((p) => {
          const grant = grants?.[p];
          return (
            <PrefRow
              key={p}
              lead={
                <span className="dk-logo">
                  <Icon name={ICON[p]} size={16} />
                </span>
              }
              title={t(`desktop.prepare.${p}`)}
              desc={t(`desktop.prepare.${p}Desc`)}
              end={
                grant === "on" ? (
                  <Chip icon="check" tone="done">
                    {t("desktop.prepare.on")}
                  </Chip>
                ) : grant ? (
                  <Button
                    size="sm"
                    loading={pending === p}
                    disabled={pending !== null && pending !== p}
                    onClick={() => void ask(p)}
                  >
                    {t(grant === "ask" ? "desktop.pair.allow" : "desktop.prepare.openSettings")}
                  </Button>
                ) : null
              }
            />
          );
        })}
      </PrefCard>
      {line}
    </>
  );
}
