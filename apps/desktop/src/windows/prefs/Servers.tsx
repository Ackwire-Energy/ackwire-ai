import { Button, Chip, Dialog, DialogFooter, Menu, MenuItem, Switch } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import { isHereServer, type LocalServerStatus, type ReachStage, type ServeProblem } from "../../control/local-server";
import {
  homeServer,
  type ServerKind,
  type ServerList,
  type ServerWorkspaces,
  serverKind,
  serverName,
} from "../../control/server";
import { pairedHomes } from "../../control/store";
import { useLocalServer, useOnShown, usePending, useTailnet } from "../../hooks";
import { CopyDetails, ReachProblem, ReachProgress, ReachRow, ServerTile } from "../../ui/here";
import { CardTitle, hintFor, PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { clock, shortPath } from "../../ui/time";

const KIND_SUB: Record<ServerKind, string> = {
  cloud: "desktop.servers.cloudSub",
  tailnet: "desktop.servers.ownTailnet",
  here: "desktop.servers.ownHere",
  own: "desktop.servers.ownSub",
};

/**
 * Preferences › Servers: where this app opens agentes.chat, each with its workspaces (ADR 0154). Each keeps its own
 * sign-in (cookies are per origin).
 */
export function Servers() {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const [list, setList] = useState<ServerList>({ current: null, servers: [] });
  const [spaces, setSpaces] = useState<ServerWorkspaces[]>([]);
  const local = useLocalServer();
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = () => {
    void host
      .servers()
      .then(setList)
      .catch(() => {});
    void host
      .workspaces()
      .then(setSpaces)
      .catch(() => {});
  };
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

  const signOut = async (server: string) => {
    try {
      await host.signOutServer(server);
      toast(t("desktop.servers.signedOutDone", { host: serverName(server) }));
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
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
              const known = spaces.find((s) => s.server === server);
              const offline = known?.offlineSince !== undefined;
              const signedOut = known !== undefined && !known.signedIn && !offline;
              return (
                <PrefRow
                  key={server}
                  lead={<ServerTile kind={kind} />}
                  title={serverName(server)}
                  desc={
                    <>
                      {[t(KIND_SUB[kind]), known && !offline && workspacesLine(t, known)].filter(Boolean).join(" · ")}
                      {/* Its state as words in its color, never a pill (ADR 0158). */}
                      {offline && (
                        <span className="dk-state-waiting">
                          {" · "}
                          {t("desktop.servers.offline", {
                            time: clock(new Date(known?.offlineSince ?? Date.now()).toISOString(), i18n.language),
                          })}
                        </span>
                      )}
                    </>
                  }
                  under={
                    known?.signedIn && known.orgs.length > 0 ? (
                      <WorkspaceChips orgs={known.orgs} dim={offline} />
                    ) : undefined
                  }
                  end={
                    <>
                      {signedOut ? (
                        <Button size="sm" variant="primary" onClick={() => void open(server)}>
                          {t("desktop.servers.signIn")}
                        </Button>
                      ) : now ? (
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
                        {known?.signedIn && (
                          <MenuItem icon="arrowRight" onSelect={() => void signOut(server)}>
                            {t("desktop.servers.signOut")}
                          </MenuItem>
                        )}
                        <MenuItem icon="trash" danger onSelect={() => setRemoving(server)}>
                          {t("desktop.servers.removeFromApp")}
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

/** "2 workspaces", or that the app isn't signed in there. */
function workspacesLine(t: (key: string, o?: Record<string, unknown>) => string, s: ServerWorkspaces) {
  return s.signedIn ? t("desktop.servers.workspaces", { count: s.orgs.length }) : t("desktop.servers.signedOut");
}

/** A server's workspaces under its row, each with its logo and unread count; `dim` while it doesn't answer. */
function WorkspaceChips({ orgs, dim = false }: { orgs: ServerWorkspaces["orgs"]; dim?: boolean }) {
  return (
    <span className="dk-ws-list" data-dim={dim || undefined}>
      {orgs.map((o) => (
        <Chip key={o.id}>
          {o.logo && <img className="dk-ws-logo" src={o.logo} alt="" width={16} height={16} />}
          {o.name}
          {o.unread > 0 && <span className="dk-ws-count">{o.unread}</span>}
        </Chip>
      ))}
    </span>
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
 * devices (Tailscale) and the phone's QR code with it, the usage-statistics switch, the way to Jev's key, its
 * version, data and backups, Restart and Stop, and "Stop running it here…" (its data stays).
 */
function HereServer({ local, current }: { local: LocalServerStatus; current: string | null }) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const tailnet = useTailnet();
  const [reaching, setReaching] = useState(false);
  // What turning reach on or off is doing, said while it takes (Tailscale, its HTTPS page, the restart).
  const [stage, setStage] = useState<ReachStage | null>(null);
  const [reachProblem, setReachProblem] = useState<ServeProblem | null>(null);
  const [busy, run] = usePending<"restart" | "stop" | "start" | "usage" | "backup">();
  const [stopping, setStopping] = useState(false);
  // Stop asks first (the phone and the team lose access), and how long; turning reach off asks too (ADR 0158).
  const [stopAsk, setStopAsk] = useState(false);
  const [reachOffAsk, setReachOffAsk] = useState(false);
  const address = local.publicUrl ?? local.url ?? "";
  const running = local.phase === "running";
  const up = running || local.phase === "starting" || local.phase === "updating";

  const act = (what: NonNullable<typeof busy>, action: () => Promise<unknown>) =>
    run(what, () => action().catch(() => toast(t("desktop.common.error"), "alert")));
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
        {local.held
          ? local.heldUntil
            ? t("desktop.server.stoppedUntil", {
                time: clock(new Date(local.heldUntil).toISOString(), i18n.language),
              })
            : t("desktop.server.stoppedHeld")
          : t(`desktop.server.${local.phase === "off" ? "stopped" : local.phase}`)}
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
        {local.phase === "failing" && (
          <PrefRow
            desc={t("desktop.server.failingWhy")}
            end={
              <>
                <CopyDetails />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void host.revealFolder(logsFolder(local.dir)).catch(() => {})}
                >
                  {t("desktop.server.showLogs")}
                </Button>
              </>
            }
          />
        )}
        <ReachRow
          tailnet={tailnet}
          on={local.reach}
          busy={reaching || !running}
          onChange={(on) => (on ? void reach(true) : setReachOffAsk(true))}
        />
        <PrefRow desc={t("desktop.server.reachRestart")} />
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
              disabled={busy !== null}
              onCheckedChange={(on) => void act("usage", () => host.setLocalUsage(on))}
            />
          }
        />
        {/* Only the way there, no state: Jev's key is the server's, its owner sets it on the web, and the app has no
            session there to read it with. */}
        <PrefRow
          title={t("desktop.server.jev")}
          hint={hintFor(t, t("desktop.server.jev"), t("desktop.server.jevText"))}
          desc={t("desktop.server.jevWhere")}
          end={
            <Button
              size="sm"
              disabled={!running}
              onClick={() => void host.openExternal(`${address}/?open=jev`).catch(() => {})}
            >
              {t("desktop.servers.open")}
            </Button>
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
                disabled={!up || busy !== null}
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
              onClick={() => setStopAsk(true)}
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
        open={stopAsk}
        onOpenChange={(o) => !o && busy !== "stop" && setStopAsk(false)}
        title={t("desktop.server.stopTitle")}
        description={t("desktop.server.stopBody")}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setStopAsk(false)} disabled={busy === "stop"}>
            {t("desktop.common.cancel")}
          </Button>
          <Button
            disabled={busy === "stop"}
            onClick={() =>
              void act("stop", async () => {
                await host.stopLocalServer(false, 60);
                setStopAsk(false);
              })
            }
          >
            {t("desktop.server.stopFor1h")}
          </Button>
          <Button
            variant="danger"
            loading={busy === "stop"}
            onClick={() =>
              void act("stop", async () => {
                await host.stopLocalServer(false);
                setStopAsk(false);
              })
            }
          >
            {t("desktop.server.stopUntilStart")}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={reachOffAsk}
        onOpenChange={(o) => !o && setReachOffAsk(false)}
        title={t("desktop.server.reachOffTitle")}
        description={t("common.joinSentences", {
          a: t("desktop.server.reachOffBody"),
          b: t("desktop.server.reachRestart"),
        })}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setReachOffAsk(false)}>
            {t("desktop.common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setReachOffAsk(false);
              void reach(false);
            }}
          >
            {t("desktop.server.reachOffConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
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

/** Where the server here writes its log (`logs/server.log` in its folder), with the folder's own separator. */
const logsFolder = (dir: string) => `${dir}${dir.includes("\\") ? "\\" : "/"}logs`;
