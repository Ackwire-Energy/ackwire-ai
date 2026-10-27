import { Button, Chip, Dialog, DialogFooter, Menu, MenuItem, Switch } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import { isHereServer, type LocalServerStatus, type ReachStage, type ServeProblem } from "../../control/local-server";
import { homeServer, type ServerKind, type ServerList, serverKind, serverName } from "../../control/server";
import { pairedHomes } from "../../control/store";
import { useLocalServer, useOnShown, useTailnet } from "../../hooks";
import { ReachProblem, ReachProgress, ReachRow, ServerTile } from "../../ui/here";
import { CardTitle, hintFor, PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { shortPath } from "../../ui/time";

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
  const local = useLocalServer();
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = () =>
    void host
      .servers()
      .then(setList)
      .catch(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: again when the server here's address moves
  useEffect(read, [host, local.publicUrl, local.run]);
  useOnShown("prefs", read);

  const homesOf = (server: string) => pairedHomes(snap).filter((h) => homeServer(h) === server);
  // The server here has its own card, above.
  const others = list.servers.filter((server) => !isHereServer(local, server));

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
      {local.run && <HereServer local={local} current={list.current} />}
      {!local.run && local.installed === "app" && local.owner && <StoppedHere local={local} />}
      {others.length > 0 && (
        <>
          {local.run && <CardTitle>{t("desktop.servers.title")}</CardTitle>}
          <PrefCard>
            {others.map((server) => {
              const kind = serverKind(server);
              const now = server === list.current;
              return (
                <PrefRow
                  key={server}
                  lead={<ServerTile kind={kind} />}
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
        </>
      )}
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

/** agentes.chat on this computer, stopped running here ("Stop running it here…"): its data stays, Start brings it back. */
function StoppedHere({ local }: { local: LocalServerStatus }) {
  const { t } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <PrefCard>
      <PrefRow
        lead={<ServerTile kind="here" />}
        title={t("desktop.server.title")}
        desc={t("desktop.server.notHere", { path: shortPath(local.dir) })}
        end={
          <Button
            size="sm"
            icon="play"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void host
                .startLocalServer()
                .catch(() => toast(t("desktop.common.error"), "alert"))
                .finally(() => setBusy(false));
            }}
          >
            {t("desktop.server.startHere")}
          </Button>
        }
      />
    </PrefCard>
  );
}

/**
 * agentes.chat on this computer (the app runs it): its state and address, reach from the person's other
 * devices (Tailscale) and the phone's QR code with it, the usage-statistics switch, its version, data and
 * backups, Restart and Stop, and "Stop running it here…" (its data stays).
 */
function HereServer({ local, current }: { local: LocalServerStatus; current: string | null }) {
  const { t } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const tailnet = useTailnet();
  const [reaching, setReaching] = useState(false);
  // What turning reach on or off is doing, said while it takes (Tailscale, its HTTPS page, the restart).
  const [stage, setStage] = useState<ReachStage | null>(null);
  const [reachProblem, setReachProblem] = useState<ServeProblem | null>(null);
  const [busy, setBusy] = useState<"restart" | "stop" | "start" | "usage" | "backup" | null>(null);
  const [stopping, setStopping] = useState(false);
  const address = local.publicUrl ?? local.url ?? "";
  const running = local.phase === "running";
  const up = running || local.phase === "starting" || local.phase === "updating";

  const act = async (what: NonNullable<typeof busy>, run: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await run();
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => host.onLocalReach(setStage), [host]);
  const reach = async (on: boolean) => {
    setReaching(true);
    setStage(null);
    setReachProblem(null);
    try {
      const result = await host.setLocalReach(on);
      // Stopped waiting by the person: nothing went wrong to say.
      if (!result.ok && result.problem.reason !== "stopped") setReachProblem(result.problem);
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setReaching(false);
    }
  };
  const chip =
    local.phase === "running" ? (
      <Chip icon="check" tone="done">
        {t("desktop.server.running")}
      </Chip>
    ) : (
      <Chip icon={local.phase === "failing" || local.phase === "stopped" ? "alert" : undefined} tone="waiting">
        {t(`desktop.server.${local.phase === "off" ? "stopped" : local.phase}`)}
      </Chip>
    );

  return (
    <>
      <PrefCard>
        <PrefRow
          lead={<ServerTile kind="here" />}
          title={t("desktop.server.title")}
          desc={t(local.reach ? "desktop.servers.hereTailnet" : "desktop.servers.hereOnly")}
          end={chip}
        />
        <PrefRow
          title={t("desktop.server.address")}
          desc={<span className="dk-path">{address}</span>}
          end={
            current === address ? (
              <Chip icon="check" tone="done">
                {t("desktop.servers.openNow")}
              </Chip>
            ) : (
              <Button size="sm" disabled={!address} onClick={() => void host.chooseServer(address).catch(() => {})}>
                {t("desktop.servers.open")}
              </Button>
            )
          }
        />
        <ReachRow tailnet={tailnet} on={local.reach} busy={reaching || !running} onChange={(on) => void reach(on)} />
        {reaching && stage && <PrefRow desc={<ReachProgress stage={stage} />} />}
        {reachProblem && <PrefRow desc={<ReachProblem problem={reachProblem} text="prefs" />} />}
        <PrefRow
          title={t("desktop.server.phone")}
          desc={local.reach ? undefined : t("desktop.server.phoneOff")}
          end={
            <Button
              size="sm"
              icon="phone"
              disabled={!local.reach || !running}
              onClick={() => void host.openExternal(`${address}/?open=phone`).catch(() => {})}
            >
              {t("desktop.server.showQr")}
            </Button>
          }
        />
        {/* The restart stays in sight, under the label: it reaches whoever is using agentes.chat at that moment.
            The switch is described by it too, after its hint. */}
        <PrefRow
          top
          title={t("desktop.here.usage")}
          hint={hintFor(t, t("desktop.here.usage"), t("desktop.here.usageText"))}
          desc={<span id="here-usage-prefs-line">{t("desktop.server.usageRestart")}</span>}
          htmlFor="here-usage-prefs"
          end={
            <Switch
              id="here-usage-prefs"
              aria-describedby="here-usage-prefs-hint here-usage-prefs-line"
              checked={local.usage}
              disabled={busy === "usage"}
              onCheckedChange={(on) => void act("usage", () => host.setLocalUsage(on))}
            />
          }
        />
        {local.version && <PrefRow desc={t("desktop.server.version", { version: local.version })} />}
        <PrefRow
          title={t("desktop.server.data")}
          desc={<span className="dk-path">{shortPath(local.dir)}</span>}
          end={
            <>
              <Button
                size="sm"
                loading={busy === "backup"}
                disabled={!up}
                onClick={() =>
                  void act("backup", async () => {
                    const file = await host.backupLocalServer();
                    toast(t("desktop.server.backedUp", { file: shortPath(file) }), "check");
                  })
                }
              >
                {t("desktop.server.backup")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void host.revealFolder(local.dir).catch(() => {})}>
                {host.platform === "mac" ? t("desktop.server.reveal") : t("desktop.server.revealFiles")}
              </Button>
            </>
          }
        />
      </PrefCard>
      <div className="dk-under-card dk-here__acts">
        {up ? (
          <>
            <Button
              size="sm"
              icon="refresh"
              loading={busy === "restart"}
              disabled={busy !== null}
              onClick={() => void act("restart", () => host.restartLocalServer())}
            >
              {t("desktop.server.restart")}
            </Button>
            <Button
              size="sm"
              icon="stop"
              loading={busy === "stop"}
              disabled={busy !== null}
              onClick={() => void act("stop", () => host.stopLocalServer(false))}
            >
              {t("desktop.server.stop")}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon="play"
            loading={busy === "start"}
            onClick={() => void act("start", () => host.startLocalServer())}
          >
            {t("desktop.server.start")}
          </Button>
        )}
        <span className="dk-here__end">
          <Button size="sm" variant="ghost" className="dk-danger-text" onClick={() => setStopping(true)}>
            {t("desktop.server.stopHere")}
          </Button>
        </span>
      </div>
      <Dialog
        open={stopping}
        onOpenChange={(o) => !o && busy !== "stop" && setStopping(false)}
        title={t("desktop.server.stopHereTitle")}
        description={t("desktop.server.stopHereBody", { path: shortPath(local.dir) })}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setStopping(false)} disabled={busy === "stop"}>
            {t("desktop.common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={busy === "stop"}
            onClick={() =>
              void act("stop", async () => {
                await host.stopLocalServer(true);
                setStopping(false);
              })
            }
          >
            {t("desktop.server.stopHereConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
