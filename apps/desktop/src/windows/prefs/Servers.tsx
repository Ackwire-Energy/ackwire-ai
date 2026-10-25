import { Button, Chip, Dialog, DialogFooter, Icon, type IconName, Menu, MenuItem } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import { homeServer, type ServerKind, type ServerList, serverKind, serverName } from "../../control/server";
import { pairedHomes } from "../../control/store";
import { useOnShown } from "../../hooks";
import { useToast } from "../../ui/Toast";
import { PrefCard, PrefHead, PrefRow } from "./shared";

const KIND_ICON: Record<ServerKind, IconName> = { cloud: "cloud", tailnet: "globe", here: "computer", own: "globe" };
const KIND_SUB: Record<ServerKind, string> = {
  cloud: "desktop.servers.cloudSub",
  tailnet: "desktop.servers.ownTailnet",
  here: "desktop.servers.ownHere",
  own: "desktop.servers.ownSub",
};

/** Preferences › Servers: where this app opens agentes.chat. Each keeps its own sign-in (cookies are per origin). */
export function Servers() {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const [list, setList] = useState<ServerList>({ current: null, servers: [] });
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = () =>
    void host
      .servers()
      .then(setList)
      .catch(() => {});
  useEffect(read, [host]);
  useOnShown("prefs", read);

  const homesOf = (server: string) => pairedHomes(snap).filter((h) => homeServer(h) === server);

  const open = async (server: string) => {
    await host.chooseServer(server).catch(() => toast(t("desktop.common.error"), "alert"));
    read();
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      // Its organizations' agents stop working here; their folders stay, as when leaving one.
      for (const h of homesOf(removing)) {
        await store.request(h.homeId, { type: "unpair" }).catch(() => {});
        await store.removeHome(h.homeId);
      }
      await host.removeServer(removing);
      toast(t("desktop.servers.removed", { host: serverName(removing) }));
      setRemoving(null);
      read();
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PrefHead title={t("desktop.servers.title")} lead={t("desktop.servers.lead")} />
      <PrefCard>
        {list.servers.map((server) => {
          const kind = serverKind(server);
          const now = server === list.current;
          return (
            <PrefRow
              key={server}
              lead={
                <span className="dk-logo dk-logo--soft">
                  <Icon name={KIND_ICON[kind]} size={16} />
                </span>
              }
              title={serverName(server)}
              desc={t(KIND_SUB[kind])}
              end={
                <>
                  {now ? (
                    <Chip icon="check" tone="done">
                      {t("desktop.servers.openNow")}
                    </Chip>
                  ) : (
                    <Button size="sm" onClick={() => void open(server)}>
                      {t("desktop.servers.open")}
                    </Button>
                  )}
                  <Menu
                    align="end"
                    label={t("desktop.servers.more", { host: serverName(server) })}
                    trigger={
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        icon="more"
                        aria-label={t("desktop.servers.more", { host: serverName(server) })}
                      />
                    }
                  >
                    <MenuItem icon="trash" danger onSelect={() => setRemoving(server)}>
                      {t("desktop.servers.remove")}
                    </MenuItem>
                  </Menu>
                </>
              }
            />
          );
        })}
      </PrefCard>
      <div className="dk-under-card">
        <Button size="sm" icon="plus" onClick={() => void host.showWindow("welcome")}>
          {t("desktop.servers.add")}
        </Button>
      </div>

      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && !busy && setRemoving(null)}
        title={t("desktop.servers.removeTitle", { host: removing ? serverName(removing) : "" })}
        description={
          <>
            {t("desktop.servers.removeBody")}
            {removing && homesOf(removing).length > 0 && <> {t("desktop.servers.removeAgents")}</>}
          </>
        }
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setRemoving(null)} disabled={busy}>
            {t("desktop.common.cancel")}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            {t("desktop.servers.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
