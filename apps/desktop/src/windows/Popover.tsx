/**
 * The menu bar popover (AppBandeja.html, views "tray" and "ask"): what the agents are doing now on
 * this Mac, grouped by organization, folder requests on top, pause for the whole computer, and the
 * way to Preferences, the site and Quit. This window also owns the tray icon's state and raises the
 * macOS notification for folder requests (it lives, hidden, for as long as the app runs).
 */
import type { ControlAccessRequest, ControlJob } from "@agenteschat/adapters/runner-control";
import { Button, Icon, Kbd, normalizeAppearance, PixelSpinner, Segmented } from "@agenteschat/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../app";
import { combinedPause, extendPause, type PauseChoice, pauseUntil } from "../control/pause";
import { type Home, isIncompatible, isRefusedHome, orgName, pairedHomes, RECONNECT_PREF } from "../control/store";
import { isOnline, macStateOf, trayStateOf } from "../control/tray";
import { SITE_URL } from "../control/version";
import { agentOf, useOnShown, useUpdateCheck, writePref } from "../hooks";
import { AgentFace, Banner, BrandFace, Count, MacPortrait, MenuRow, OrgTile } from "../ui/bits";
import { useToast } from "../ui/Toast";
import { baseName, clock, shortPath, since } from "../ui/time";

const POP_WIDTH = 360;
/** Transparent margin around the card, so its shadow (`.dk-pop`) isn't cut by the window's edge. */
const POP_PAD = { x: 22, top: 6, bottom: 34 };
const POP_PADDING = `${POP_PAD.top}px ${POP_PAD.x}px ${POP_PAD.bottom}px`;
const POP_MAX_HEIGHT = 680;

export function Popover() {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const update = useUpdateCheck(true);
  const [pauseMenu, setPauseMenu] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const card = useRef<HTMLElement>(null);

  const homes = pairedHomes(snap);
  const pause = combinedPause(homes.map((h) => h.status?.paused ?? { paused: false }));
  const allOffline = homes.length > 0 && homes.every((h) => !isOnline(h));
  const jobs = homes.flatMap((h) => h.jobs);
  const requests = homes.flatMap((h) => h.requests.map((r) => ({ home: h, request: r })));
  const incompatible = snap.homes.some(isIncompatible);
  const refused = homes.find(isRefusedHome);
  const outdated = homes.some((h) => h.status?.connection === "outdated");
  const machine = homes.find((h) => h.status?.machine)?.status?.machine?.name ?? t("desktop.tray.label");

  // The tray icon follows the aggregate state.
  const tray = trayStateOf(homes, update.state.available || update.state.required || outdated);
  useEffect(() => {
    void host.setTrayState(tray).catch(() => {});
  }, [host, tray]);

  // "há 2 min" stays true.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useOnShown("popover", () => {
    setPauseMenu(false);
    setConfirmQuit(false);
    setNow(Date.now());
  });

  // The window follows the card's height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe the new card after switching views
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const h = Math.min(POP_MAX_HEIGHT, Math.ceil(el.getBoundingClientRect().height) + POP_PAD.top + POP_PAD.bottom);
      void host.resize(POP_WIDTH + POP_PAD.x * 2, h).catch(() => {});
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [host, confirmQuit]);

  const openSite = () => {
    void host.openExternal(SITE_URL).catch(() => {});
    void host.hideWindow("popover").catch(() => {});
  };
  const openPrefs = (tab?: string) => {
    if (tab) writePref("prefsTab", tab);
    void host.showWindow("prefs").catch(() => {});
  };
  const addOrg = () => void host.showWindow("welcome").catch(() => {});
  /** "Reconectar este Mac": the connect window, on the refused organization's home (same computer back). */
  const reconnectMac = (home: Home) => {
    writePref(RECONNECT_PREF, home.homeId);
    void host.showWindow("welcome").catch(() => {});
    void host.hideWindow("popover").catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmQuit) setConfirmQuit(false);
        else if (pauseMenu) setPauseMenu(false);
        else void host.hideWindow("popover").catch(() => {});
        return;
      }
      if (!e.metaKey && !e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === "o") {
        e.preventDefault();
        openSite();
      } else if (k === ",") {
        e.preventDefault();
        openPrefs();
      } else if (k === "q") {
        e.preventDefault();
        setConfirmQuit(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const doPause = async (choice: PauseChoice) => {
    setPauseMenu(false);
    try {
      await store.requestAll({ type: "pause", until: pauseUntil(choice) });
      toast(
        t(
          choice === "1h"
            ? "desktop.tray.pausedFor1h"
            : choice === "tomorrow"
              ? "desktop.tray.pausedTomorrow"
              : "desktop.tray.pausedManual",
        ),
        "pause",
      );
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };
  const doResume = async () => {
    try {
      await store.requestAll({ type: "resume" });
      toast(t("desktop.tray.resumed"), "play");
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };
  /** Drops every organization's connection and opens it again at once (a stuck or half-open one). */
  const doReconnect = async () => {
    try {
      await store.requestAll({ type: "reconnect" });
      toast(t("desktop.tray.reconnecting"), "refresh");
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };
  const plusHour = async () => {
    if (!pause) return;
    try {
      await store.requestAll({ type: "pause", until: extendPause(pause) });
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };

  if (confirmQuit) {
    return (
      <div className="dk-pop-shell" style={{ padding: POP_PADDING }}>
        <main className="dk-pop" ref={card} aria-label={t("desktop.tray.quitTitle")}>
          <div className="dk-confirm">
            <h2>{t("desktop.tray.quitTitle")}</h2>
            <p>{t("desktop.tray.quitBody")}</p>
            <div className="dk-confirm__foot">
              <Button variant="ghost" size="sm" onClick={() => setConfirmQuit(false)}>
                {t("desktop.common.cancel")}
              </Button>
              <Button variant="primary" size="sm" onClick={() => void host.quit()}>
                {t("desktop.tray.quitConfirm")}
              </Button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const mod = "⌘";
  return (
    <div className="dk-pop-shell" style={{ padding: POP_PADDING }}>
      <main className="dk-pop" ref={card} aria-label={t("desktop.tray.label")}>
        <header className="dk-ph">
          <MacPortrait state={macStateOf(homes)} />
          <span className="dk-ph__text">
            <b>{machine}</b>
            <small>
              {homes.length ? t("desktop.orgCount", { count: homes.length }) : t("desktop.tray.noOrgsTitle")}
            </small>
          </span>
        </header>

        {incompatible && (
          <Banner icon="alert" title={t("desktop.tray.incompatibleTitle")}>
            {t("desktop.tray.incompatibleBody")}
          </Banner>
        )}
        {(update.state.required || outdated) && (
          <Banner
            icon="download"
            title={t("desktop.tray.requiredTitle")}
            actions={
              <Button size="sm" variant="primary" onClick={() => openPrefs("updates")}>
                {t("desktop.tray.updateSee")}
              </Button>
            }
          >
            {t("desktop.tray.requiredBody")}
          </Banner>
        )}
        {refused && (
          <Banner
            icon="alert"
            title={t("desktop.tray.refusedTitle", { org: orgName(refused) })}
            actions={
              <>
                <Button size="sm" variant="primary" icon="refresh" onClick={() => reconnectMac(refused)}>
                  {t("desktop.tray.reconnectMac")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openPrefs("general")}>
                  {t("desktop.tray.prefs")}
                </Button>
              </>
            }
          >
            {t("desktop.tray.refusedBody")}
          </Banner>
        )}
        {allOffline && !refused && !outdated && (
          <Banner
            lead={<PixelSpinner size={16} />}
            title={t("desktop.tray.offlineTitle")}
            actions={
              <Button size="sm" icon="refresh" onClick={() => void doReconnect()}>
                {t("desktop.tray.reconnect")}
              </Button>
            }
          >
            {t("desktop.tray.offlineBody")}
          </Banner>
        )}
        {pause && (
          <Banner
            icon="pause"
            title={
              pause.until
                ? t("desktop.tray.pausedUntil", { time: clock(pause.until, i18n.language) })
                : t("desktop.tray.pausedUntilResume")
            }
            actions={
              <>
                <Button size="sm" variant="primary" icon="play" onClick={() => void doResume()}>
                  {t("desktop.tray.resumeNow")}
                </Button>
                {pause.until && (
                  <Button size="sm" variant="ghost" onClick={() => void plusHour()}>
                    {t("desktop.tray.plusHour")}
                  </Button>
                )}
              </>
            }
          >
            {t("desktop.tray.pausedBody")}
          </Banner>
        )}
        {!update.state.required && update.state.available && update.state.latest && (
          <Banner
            icon="download"
            title={t("desktop.tray.updateTitle", { version: update.state.latest.version })}
            actions={
              <Button size="sm" variant="primary" onClick={() => openPrefs("updates")}>
                {t("desktop.tray.updateSee")}
              </Button>
            }
          >
            {t("desktop.tray.updateBody")}
          </Banner>
        )}

        {requests.length > 0 && (
          <section className="dk-psec">
            <div className="dk-pcap">
              {t("desktop.tray.requests")} <Count n={requests.length} />
            </div>
            {requests.map(({ home, request }) => (
              <RequestCard key={request.requestId} home={home} request={request} now={now} />
            ))}
          </section>
        )}

        <section className="dk-psec">
          <div className="dk-pcap">
            {t("desktop.tray.now")} <Count n={jobs.length} />
            {jobs.length > 0 && (
              <span className="dk-pcap__end">
                <button type="button" className="dk-link" onClick={openSite}>
                  {t("desktop.tray.seeAll")} <Icon name="external" size={14} />
                </button>
              </span>
            )}
          </div>
          <NowList homes={homes} paused={!!pause} now={now} />
        </section>

        <section className="dk-psec">
          {pause ? (
            <MenuRow icon="play" onClick={() => void doResume()}>
              {t("desktop.tray.resume")}
            </MenuRow>
          ) : (
            homes.length > 0 && (
              <>
                <MenuRow
                  icon="pause"
                  expanded={pauseMenu}
                  onClick={() => setPauseMenu((v) => !v)}
                  trailing={<Icon name={pauseMenu ? "chevronDown" : "chevronRight"} size={14} />}
                >
                  {t("desktop.tray.pause")}
                </MenuRow>
                {pauseMenu && (
                  <div className="dk-sub">
                    <MenuRow icon="clock" onClick={() => void doPause("1h")}>
                      {t("desktop.tray.pause1h")}
                    </MenuRow>
                    <MenuRow icon="calendar" onClick={() => void doPause("tomorrow")}>
                      {t("desktop.tray.pauseTomorrow")}
                    </MenuRow>
                    <MenuRow icon="pause" onClick={() => void doPause("manual")}>
                      {t("desktop.tray.pauseManual")}
                    </MenuRow>
                    <span className="dk-help dk-sub__hint">{t("desktop.tray.pauseHint")}</span>
                  </div>
                )}
              </>
            )
          )}
          {homes.length > 0 && (
            <MenuRow icon="refresh" onClick={() => void doReconnect()}>
              {t("desktop.tray.reconnect")}
            </MenuRow>
          )}
          <MenuRow icon="plus" onClick={addOrg}>
            {t("desktop.tray.addOrg")}
          </MenuRow>
          <MenuRow
            icon="external"
            onClick={openSite}
            trailing={
              <>
                <Kbd>{mod}</Kbd>
                <Kbd>O</Kbd>
              </>
            }
          >
            {t("desktop.tray.openSite")}
          </MenuRow>
          <MenuRow
            icon="settings"
            onClick={() => openPrefs(update.state.available ? "updates" : undefined)}
            trailing={
              <>
                {update.state.available && <Icon name="download" size={14} />}
                <Kbd>{mod}</Kbd>
                <Kbd>,</Kbd>
              </>
            }
          >
            {t("desktop.tray.prefs")}
          </MenuRow>
        </section>
        <section className="dk-psec">
          <MenuRow
            icon="stop"
            onClick={() => setConfirmQuit(true)}
            trailing={
              <>
                <Kbd>{mod}</Kbd>
                <Kbd>Q</Kbd>
              </>
            }
          >
            {t("desktop.tray.quit")}
          </MenuRow>
        </section>
      </main>
    </div>
  );
}

/** "Agora": live jobs grouped by organization (each one is its own runner on this Mac). */
function NowList({ homes, paused, now }: { homes: Home[]; paused: boolean; now: number }) {
  const { t } = useTranslation();
  if (homes.length === 0) {
    return (
      <div className="dk-empty">
        <BrandFace size="sm" />
        <span className="dk-empty__text">
          <b>{t("desktop.tray.noOrgsTitle")}</b>
          <span>{t("desktop.tray.noOrgsBody")}</span>
        </span>
      </div>
    );
  }
  const total = homes.reduce((n, h) => n + h.jobs.length, 0);
  if (total === 0) {
    const someone = homes.flatMap((h) => h.status?.agents ?? [])[0];
    return (
      <div className="dk-empty">
        {someone ? (
          <AgentFace agent={someone} size="sm" state={paused ? "waiting" : "idle"} />
        ) : (
          <BrandFace size="sm" />
        )}
        <span className="dk-empty__text">
          <b>{paused ? t("desktop.tray.pausedEmptyTitle") : t("desktop.tray.calmTitle")}</b>
          <span>{paused ? t("desktop.tray.pausedEmptyBody") : t("desktop.tray.calmBody")}</span>
        </span>
      </div>
    );
  }
  return (
    <>
      {homes.map((h) => (
        <div key={h.homeId}>
          <div className="dk-ohead">
            <OrgTile name={orgName(h)} logo={h.logo} size="sm" />
            {orgName(h)}
            <Count n={h.jobs.length} />
            {h.jobs.length === 0 && (
              <span className="dk-ohead__end">
                {isOnline(h) ? t("desktop.tray.nothingNow") : t("desktop.tray.waitingConnection")}
              </span>
            )}
          </div>
          {h.jobs.map((j) => (
            <JobRow key={j.id} home={h} job={j} now={now} />
          ))}
        </div>
      ))}
    </>
  );
}

function JobRow({ home, job, now }: { home: Home; job: ControlJob; now: number }) {
  const { t } = useTranslation();
  const agent = job.agent ? agentOf(home, job.agent) : null;
  const color = normalizeAppearance(agent?.look).color;
  return (
    <div className="dk-job">
      <span className="dk-job__av">
        {agent ? <AgentFace agent={agent} size="sm" state="writing" /> : <BrandFace size="sm" />}
      </span>
      <span className="dk-job__text">
        <b>
          <span>{agent ? `${agent.name} · ${job.summary}` : job.summary}</span>
        </b>
        <small>
          <PixelSpinner size={14} color={color} />
          {job.background && <span>{t("desktop.tray.background")} ·</span>}
          {job.where && <span>{job.where}</span>}
          {job.command && <code className="dk-code-inline">{job.command}</code>}
        </small>
      </span>
      <span className="dk-job__end">{since(job.startedAt, t, now)}</span>
    </div>
  );
}

/** An agent asks for a folder: Liberar (this agent or all) or Agora não. The click is on the machine. */
function RequestCard({ home, request, now }: { home: Home; request: ControlAccessRequest; now: number }) {
  const { t } = useTranslation();
  const store = useStore();
  const toast = useToast();
  const [scope, setScope] = useState<"agent" | "all">("agent");
  const [busy, setBusy] = useState(false);
  const agent = agentOf(home, request.agent);
  const folder = baseName(request.path);
  const answer = async (decision: "granted" | "denied") => {
    setBusy(true);
    try {
      await store.request(home.homeId, { type: "access.answer", requestId: request.requestId, decision, scope });
      toast(
        decision === "denied"
          ? t("desktop.tray.denied", { agent: agent.name })
          : scope === "all"
            ? t("desktop.tray.allowedAll", { folder })
            : t("desktop.tray.allowedOne", { folder, agent: agent.name }),
        decision === "denied" ? "close" : "check",
      );
    } catch {
      toast(t("desktop.common.error"), "alert");
      setBusy(false);
    }
  };
  const options = useMemo(
    () => [
      { value: "agent" as const, label: t("desktop.tray.onlyAgent", { agent: agent.name }) },
      { value: "all" as const, label: t("desktop.tray.allAgents") },
    ],
    [t, agent.name],
  );
  return (
    <div className="dk-banner dk-req">
      <div className="dk-req__who">
        <AgentFace agent={agent} size="sm" state="waiting" />
        <span className="dk-req__whotext">
          <b>{t("desktop.tray.wantsFolder", { agent: agent.name })}</b>
          <small>
            <OrgTile name={orgName(home)} logo={home.logo} size="sm" />
            {orgName(home)} · {since(request.at, t, now)}
          </small>
        </span>
      </div>
      {request.reason && <div className="dk-req__quote">“{request.reason}”</div>}
      <div className="dk-req__fold">
        <span className="dk-logo dk-logo--soft">
          <Icon name="drive" size={16} />
        </span>
        <span className="dk-req__foldtext">
          <b>{folder}</b>
          <span className="dk-path">{shortPath(request.path)}</span>
        </span>
      </div>
      <div className="dk-req__for">
        {t("desktop.tray.allowFor")}
        <Segmented
          size="sm"
          label={t("desktop.tray.allowFor")}
          value={scope}
          onValueChange={setScope}
          options={options}
        />
      </div>
      <div className="dk-banner__acts">
        <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void answer("granted")}>
          {t("desktop.tray.allow")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer("denied")}>
          {t("desktop.tray.deny")}
        </Button>
      </div>
    </div>
  );
}
