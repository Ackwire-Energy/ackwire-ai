import type { AppLocale } from "@agenteschat/i18n/locale";
import { Button, Dialog, DialogFooter, Input, Select, Switch } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import { BROWSER_NOTIFY_PREF } from "../../control/browser";
import { DOCK_PREF, MENU_BAR_PREF, menuBarShown } from "../../control/dock";
import { NOTCH_PREF } from "../../control/notch";
import { SITE_NOTIFY_PREF } from "../../control/notify";
import { homeServer } from "../../control/server";
import { type Home, orgName, pairedHomes } from "../../control/store";
import { macStateOf } from "../../control/tray";
import { useLocalServer, usePref } from "../../hooks";
import { detectedLocale, LOCALE_PREF, locales, switchDesktopLocale } from "../../i18n";
import { AgentFace, ConnectionChip, MacPortrait, OrgTile } from "../../ui/bits";
import { CardTitle, hintFor, PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { shortPath } from "../../ui/time";
import { ThisMacCards } from "./ThisMac";

export function General() {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const homes = pairedHomes(snap);
  const works = homes.length > 0;
  const mac = host.platform === "mac";
  const local = useLocalServer();
  const current = homes.find((h) => h.status?.machine)?.status?.machine?.name ?? "";
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [launch, setLaunch] = useState<boolean | null>(null);
  const [notifySite, setNotifySite] = usePref(SITE_NOTIFY_PREF, true);
  const [notify, setNotify] = usePref("notify", true);
  // Off by default: the request already comes by push and in the site's "Waiting for you".
  const [notifyBrowser, setNotifyBrowser] = usePref(BROWSER_NOTIFY_PREF, false);
  // Off by default: the window only exists while it's on.
  const [notch, setNotch] = usePref(NOTCH_PREF, false);
  const [dock, setDock] = usePref(DOCK_PREF, true);
  const [menuBar, setMenuBar] = usePref<boolean | null>(MENU_BAR_PREF, null);
  const [language, setLanguage] = usePref<AppLocale | "auto">(LOCALE_PREF, "auto");
  const [leaving, setLeaving] = useState<Home | null>(null);
  const [busy, setBusy] = useState(false);
  const iconShown = menuBarShown(menuBar, dock, works || local.run);
  useEffect(() => {
    void host.setTrayVisible(iconShown).catch(() => {});
  }, [host, iconShown]);

  // The name arrives with the first status.
  useEffect(() => {
    if (current) setName((n) => n || current);
  }, [current]);

  useEffect(() => {
    host
      .autostart()
      .then(setLaunch)
      .catch(() => setLaunch(false));
  }, [host]);

  const saveName = async () => {
    const clean = name.trim();
    if (!clean || clean === current) return;
    setSaving(true);
    try {
      await store.requestAll({ type: "config.set", patch: { name: clean } });
      await Promise.all(homes.map((h) => store.refresh(h.homeId)));
      toast(t("desktop.prefs.general.saved"));
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setSaving(false);
    }
  };

  const leave = async () => {
    if (!leaving) return;
    const org = orgName(leaving);
    setBusy(true);
    try {
      await store.request(leaving.homeId, { type: "unpair" }).catch(() => {});
      await store.removeHome(leaving.homeId);
      toast(t("desktop.prefs.general.left", { org }));
      setLeaving(null);
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setBusy(false);
    }
  };

  /** The app keeps the Dock icon or the menu bar icon: turning one off turns the other on. */
  const showDock = (on: boolean) => {
    setDock(on);
    if (!on) setMenuBar(true);
    host.setDock(on).catch(() => {
      setDock(!on);
      toast(t("desktop.common.error"), "alert");
    });
  };
  const showMenuBar = (on: boolean) => {
    setMenuBar(on);
    if (!on && !dock) showDock(true);
  };
  // Open at login has an ⓘ only where it changes something: agentes.chat running here, or agents working here.
  const launchHint = local.run ? "desktop.prefs.general.launchHere" : works ? "desktop.prefs.general.launchDesc" : null;

  return (
    <>
      <PrefHead title={t("desktop.prefs.general.title")} />

      {works && (
        <>
          <CardTitle>{t("desktop.prefs.general.thisMac")}</CardTitle>
          <PrefCard>
            <PrefRow
              lead={<MacPortrait state={macStateOf(homes)} />}
              title={t("desktop.prefs.general.name")}
              htmlFor="machine-name"
              end={
                <form
                  className="dk-inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveName();
                  }}
                >
                  <Input
                    id="machine-name"
                    value={name}
                    maxLength={64}
                    aria-label={t("desktop.prefs.general.nameLabel")}
                    onChange={(e) => setName(e.target.value)}
                  />
                  {name.trim() && name.trim() !== current && (
                    <Button type="submit" size="sm" loading={saving}>
                      {t("desktop.prefs.general.save")}
                    </Button>
                  )}
                </form>
              }
            />
          </PrefCard>

          <ThisMacCards homes={homes} />

          <CardTitle>{t("desktop.prefs.general.orgs")}</CardTitle>
          <PrefCard>
            {homes.map((h) => {
              const agents = h.status?.agents ?? [];
              const server = homeServer(h);
              const orgId = h.status?.org?.id;
              return (
                <PrefRow
                  key={h.homeId}
                  lead={<OrgTile logo={h.logo} size="lg" />}
                  title={
                    <>
                      {orgName(h)} <ConnectionChip status={h.status} running={h.running} />
                    </>
                  }
                  desc={
                    <>
                      {agents.length > 0 && (
                        <span className="dk-avs">
                          {agents.slice(0, 5).map((a) => (
                            <AgentFace key={a.id} agent={a} size="xs" />
                          ))}
                        </span>
                      )}
                      {agents.length
                        ? t("desktop.prefs.general.agents", { count: agents.length })
                        : t("desktop.prefs.general.noAgents")}
                      {h.status?.workspace && (
                        <>
                          {" · "}
                          <span className="dk-path">{shortPath(h.status.workspace)}</span>
                        </>
                      )}
                    </>
                  }
                  end={
                    <>
                      {server && orgId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void host.openExternal(`${server}/org/${encodeURIComponent(orgId)}`)}
                        >
                          {t("desktop.common.open")}
                        </Button>
                      )}
                      {/* The server here's own organizations work here by its rule (its computer, ADR 0060). */}
                      {!(local.run && server === local.url) && (
                        <Button size="sm" variant="ghost" className="dk-danger-text" onClick={() => setLeaving(h)}>
                          {t("desktop.prefs.general.leave")}
                        </Button>
                      )}
                    </>
                  }
                />
              );
            })}
          </PrefCard>
        </>
      )}

      <CardTitle>{t("desktop.prefs.general.behavior")}</CardTitle>
      <PrefCard>
        <PrefRow
          title={t("shell.language")}
          htmlFor="language"
          end={
            <Select
              id="language"
              size="sm"
              align="end"
              // Never picked: the system's language shows as the one chosen (and keeps following it until a pick).
              value={language === "auto" ? detectedLocale() : language}
              onValueChange={(v) => {
                setLanguage(v);
                switchDesktopLocale(i18n, v, host.platform);
              }}
              options={locales.map((l) => ({ value: l.code, label: l.label }))}
            />
          }
        />
        <PrefRow
          title={t("desktop.prefs.general.launchTitle")}
          hint={launchHint ? hintFor(t, t("desktop.prefs.general.launchTitle"), t(launchHint)) : undefined}
          htmlFor="launch"
          end={
            <Switch
              id="launch"
              aria-describedby={launchHint ? "launch-hint" : undefined}
              checked={launch === true}
              disabled={launch === null}
              onCheckedChange={(on) => {
                setLaunch(on);
                host.setAutostart(on).catch(() => {
                  setLaunch(!on);
                  toast(t("desktop.common.error"), "alert");
                });
              }}
            />
          }
        />
        <PrefRow
          title={t("desktop.prefs.general.notifySiteTitle")}
          hint={hintFor(t, t("desktop.prefs.general.notifySiteTitle"), t("desktop.prefs.general.notifySiteDesc"))}
          htmlFor="notify-site"
          end={
            <Switch
              id="notify-site"
              aria-describedby="notify-site-hint"
              checked={notifySite}
              onCheckedChange={(on) => {
                setNotifySite(on);
                void host.setSiteNotify(on).catch(() => {});
              }}
            />
          }
        />
        {works && (
          <>
            <PrefRow
              title={t("desktop.prefs.general.notifyTitle")}
              htmlFor="notify"
              end={<Switch id="notify" checked={notify} onCheckedChange={setNotify} />}
            />
            <PrefRow
              title={t("desktop.prefs.general.notifyBrowserTitle")}
              hint={hintFor(
                t,
                t("desktop.prefs.general.notifyBrowserTitle"),
                t("desktop.prefs.general.notifyBrowserDesc"),
              )}
              htmlFor="notify-browser"
              end={
                <Switch
                  id="notify-browser"
                  aria-describedby="notify-browser-hint"
                  checked={notifyBrowser}
                  onCheckedChange={setNotifyBrowser}
                />
              }
            />
          </>
        )}
        {mac && (
          <>
            <PrefRow
              title={t("desktop.prefs.general.dockTitle")}
              hint={hintFor(t, t("desktop.prefs.general.dockTitle"), t("desktop.prefs.general.dockDesc"))}
              htmlFor="dock"
              end={<Switch id="dock" aria-describedby="dock-hint" checked={dock} onCheckedChange={showDock} />}
            />
            <PrefRow
              title={t("desktop.prefs.general.menuBarTitle")}
              htmlFor="menu-bar"
              end={<Switch id="menu-bar" checked={iconShown} onCheckedChange={showMenuBar} />}
            />
          </>
        )}
        {mac && works && (
          <PrefRow
            title={t("desktop.prefs.general.notchTitle")}
            hint={hintFor(t, t("desktop.prefs.general.notchTitle"), t("desktop.prefs.general.notchDesc"))}
            htmlFor="notch"
            end={
              <Switch
                id="notch"
                aria-describedby="notch-hint"
                checked={notch}
                onCheckedChange={(on) => {
                  setNotch(on);
                  host.setNotch(on).catch(() => {
                    setNotch(!on);
                    toast(t("desktop.common.error"), "alert");
                  });
                }}
              />
            }
          />
        )}
      </PrefCard>

      <Dialog
        open={!!leaving}
        onOpenChange={(open) => !open && !busy && setLeaving(null)}
        title={t("desktop.prefs.general.leaveTitle", { org: leaving ? orgName(leaving) : "" })}
        description={t("desktop.prefs.general.leaveBody", { org: leaving ? orgName(leaving) : "" })}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setLeaving(null)} disabled={busy}>
            {t("desktop.common.cancel")}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void leave()}>
            {t("desktop.prefs.general.leaveConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
