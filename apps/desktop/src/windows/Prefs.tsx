/**
 * Preferences (AppBandeja.html, view "prefs"): Geral, Pastas, Ferramentas, Atualizações, Atividade,
 * Avançado. Everything here acts on this Mac through the runners; nothing is granted from the site.
 */
import { CountChip, Icon, type IconName } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSnapshot } from "../app";
import { pairedHomes } from "../control/store";
import { macStateOf } from "../control/tray";
import { readPref, useOnShown, useUpdateCheck, writePref } from "../hooks";
import { MacPortrait } from "../ui/bits";
import { Activity } from "./prefs/Activity";
import { Advanced } from "./prefs/Advanced";
import { Folders } from "./prefs/Folders";
import { General } from "./prefs/General";
import { Tools } from "./prefs/Tools";
import { Updates } from "./prefs/Updates";

export type PrefTab = "general" | "folders" | "tools" | "updates" | "activity" | "advanced";
const TABS: { id: PrefTab; icon: IconName }[] = [
  { id: "general", icon: "settings" },
  { id: "folders", icon: "drive" },
  { id: "tools", icon: "code" },
  { id: "updates", icon: "download" },
  { id: "activity", icon: "list" },
  { id: "advanced", icon: "preference" },
];
const isTab = (v: unknown): v is PrefTab => TABS.some((t) => t.id === v);

export function Prefs() {
  const { t } = useTranslation();
  const snap = useSnapshot();
  const update = useUpdateCheck(false);
  const [tab, setTab] = useState<PrefTab>(() => {
    const asked = readPref<string | null>("prefsTab", null);
    return isTab(asked) ? asked : "general";
  });

  // The popover can ask for a tab ("Ver como atualizar").
  useOnShown("prefs", () => {
    const asked = readPref<string | null>("prefsTab", null);
    if (isTab(asked)) setTab(asked);
    writePref("prefsTab", null);
    void update.check();
  });

  const homes = pairedHomes(snap);
  const machine = homes.find((h) => h.status?.machine)?.status?.machine?.name ?? "agentes";
  const folderCount = homes.reduce((n, h) => n + (h.access?.folders.length ?? 0), 0);

  return (
    <div className="dk-prefs">
      <nav className="dk-pnav" aria-label={t("desktop.prefs.nav.label")}>
        <div className="dk-pnav__who">
          <MacPortrait state={macStateOf(homes)} />
          <span className="dk-pnav__whotext">
            <b>{machine}</b>
            <small>{t("desktop.orgCount", { count: homes.length })}</small>
          </span>
        </div>
        {TABS.map(({ id, icon }) => (
          <button key={id} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
            <Icon name={icon} size={16} />
            {t(`desktop.prefs.nav.${id}`)}
            {id === "folders" && folderCount > 0 && <CountChip size="sm">{folderCount}</CountChip>}
            {id === "updates" && (update.state.available || update.state.required) && (
              <span className="dk-pnav__badge">
                <Icon name="download" size={14} />
              </span>
            )}
          </button>
        ))}
      </nav>
      <main className="dk-pbody" key={tab}>
        {tab === "general" && <General />}
        {tab === "folders" && <Folders />}
        {tab === "tools" && <Tools />}
        {tab === "updates" && <Updates update={update} />}
        {tab === "activity" && <Activity />}
        {tab === "advanced" && <Advanced />}
      </main>
    </div>
  );
}
