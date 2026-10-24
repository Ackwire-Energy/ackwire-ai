import { Button, Dialog, DialogFooter, Input, Switch } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import { BROWSER_NOTIFY_PREF } from "../../control/browser";
import { DOCK_PREF } from "../../control/dock";
import { NOTCH_PREF } from "../../control/notch";
import { type Home, orgName, pairedHomes } from "../../control/store";
import { macStateOf } from "../../control/tray";
import { SITE_URL } from "../../control/version";
import { usePref } from "../../hooks";
import { AgentFace, ConnectionChip, MacPortrait, OrgTile } from "../../ui/bits";
import { useToast } from "../../ui/Toast";
import { shortPath } from "../../ui/time";
import { CardTitle, PrefCard, PrefHead, PrefRow } from "./shared";

export function General() {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const homes = pairedHomes(snap);
  const current = homes.find((h) => h.status?.machine)?.status?.machine?.name ?? "";
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [launch, setLaunch] = useState<boolean | null>(null);
  const [notify, setNotify] = usePref("notify", true);
  // Off by default: the request already comes by push and in the site's "Esperando você".
  const [notifyBrowser, setNotifyBrowser] = usePref(BROWSER_NOTIFY_PREF, false);
  // Off by default: the window only exists while it's on.
  const [notch, setNotch] = usePref(NOTCH_PREF, false);
  const [dock, setDock] = usePref(DOCK_PREF, true);
  const [leaving, setLeaving] = useState<Home | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <>
      <PrefHead title={t("desktop.prefs.general.title")} lead={t("desktop.prefs.general.lead")} />

      <CardTitle>{t("desktop.prefs.general.thisMac")}</CardTitle>
      <PrefCard>
        <PrefRow
          lead={<MacPortrait state={macStateOf(homes)} />}
          title={t("desktop.prefs.general.name")}
          desc={t("desktop.prefs.general.nameDesc")}
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

      <CardTitle>{t("desktop.prefs.general.orgs")}</CardTitle>
      <PrefCard>
        {homes.length === 0 && (
          <PrefRow title={t("desktop.prefs.general.noOrgsTitle")} desc={t("desktop.prefs.general.noOrgsBody")} />
        )}
        {homes.map((h) => {
          const agents = h.status?.agents ?? [];
          return (
            <PrefRow
              key={h.homeId}
              lead={<OrgTile name={orgName(h)} logo={h.logo} size="lg" />}
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
                  <Button size="sm" variant="ghost" onClick={() => void host.openExternal(SITE_URL)}>
                    {t("desktop.common.open")}
                  </Button>
                  <Button size="sm" variant="ghost" className="dk-danger-text" onClick={() => setLeaving(h)}>
                    {t("desktop.prefs.general.leave")}
                  </Button>
                </>
              }
            />
          );
        })}
        <PrefRow
          title={
            <Button size="sm" icon="plus" onClick={() => void host.showWindow("welcome")}>
              {t("desktop.tray.addOrg")}
            </Button>
          }
          desc={t("desktop.prefs.general.addHint")}
        />
      </PrefCard>

      <CardTitle>{t("desktop.prefs.general.behavior")}</CardTitle>
      <PrefCard>
        <PrefRow
          title={t("desktop.prefs.general.launchTitle")}
          desc={t("desktop.prefs.general.launchDesc")}
          htmlFor="launch"
          end={
            <Switch
              id="launch"
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
          title={t("desktop.prefs.general.notifyTitle")}
          desc={t("desktop.prefs.general.notifyDesc")}
          htmlFor="notify"
          end={<Switch id="notify" checked={notify} onCheckedChange={setNotify} />}
        />
        <PrefRow
          title={t("desktop.prefs.general.notifyBrowserTitle")}
          desc={t("desktop.prefs.general.notifyBrowserDesc")}
          htmlFor="notify-browser"
          end={<Switch id="notify-browser" checked={notifyBrowser} onCheckedChange={setNotifyBrowser} />}
        />
        <PrefRow
          title={t("desktop.prefs.general.dockTitle")}
          desc={t("desktop.prefs.general.dockDesc")}
          htmlFor="dock"
          end={
            <Switch
              id="dock"
              checked={dock}
              onCheckedChange={(on) => {
                setDock(on);
                host.setDock(on).catch(() => {
                  setDock(!on);
                  toast(t("desktop.common.error"), "alert");
                });
              }}
            />
          }
        />
        <PrefRow
          title={t("desktop.prefs.general.notchTitle")}
          desc={t("desktop.prefs.general.notchDesc")}
          htmlFor="notch"
          end={
            <Switch
              id="notch"
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
