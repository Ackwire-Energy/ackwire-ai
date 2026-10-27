import type { Agent } from "@agenteschat/client";
import {
  controlledBy,
  handoffMinutesLeft,
  isWaitingHandoff,
  useBrowserHandoffMutations,
  useMachineOutages,
} from "@agenteschat/client";
import {
  asksMe,
  type ComputerSurface,
  entryLine,
  entryState,
  liveSubLine,
  surfaceOf,
} from "@agenteschat/client/lib/agent-computer";
import { computerName, READY_FLASH_MS, WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { clockAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { computerKind, isPaused } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { AGENT_GRADIENTS, Button, ComputerPortrait, cx, Dialog, Icon, SkyStrip } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useDirectory } from "@/hooks/useDirectory";
import { useKeyboardLock } from "@/hooks/useKeyboardLock";
import { useNow } from "@/hooks/useNow";
import { useSaid, useToast } from "@/lib/toast";
import { BrowserCard, Cover, stepText } from "../browser/BrowserCard";
import { DesktopView } from "../desktop/DesktopView";
import { SwitchComputerDialog } from "../MachineOutages";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { SetupWait, useWaitReader } from "../WorkspaceComputer";
import { CantShowCover, Stage } from "./covers";
import { type AgentComputerView, useAgentComputer } from "./facts";
import { DialogHead, DialogHeadContext, type DialogHeadSlots } from "./head";
import { OpenComputerContext, useOpenComputer } from "./open";
import "./computer.css";

/**
 * The agent's computer in one dialog (web): watch it live, take control, hand back, full screen, close. A
 * computer with screens shows the agent's screen, its browser a window on it; one without (a Mac) the
 * agent's page; a person helping with a browser request gets the page, never the whole screen.
 */

/** How often the screen's state is asked while the dialog shows no live screen (the screen asks its own). */
const POLL_MS = 5_000;
/** While the page shows: it has a stream of its own; the screen may come on meanwhile. */
const PAGE_POLL_MS = 30_000;
/** How long the full-screen bar stays once nothing asks for it. */
const BAR_MS = 2_500;
/**
 * In control the pointer is the computer's: the bar comes back only once it rests this long at the display's top
 * edge, where it also stops on its way to the computer's own top bar.
 */
const BAR_EDGE_PX = 8;
const BAR_EDGE_MS = 500;

/**
 * Full screen fills the screen with the dialog. The page itself goes full screen, not the dialog: noVNC's
 * mouse-capture layer lives on the page's body, and outside the full-screen element it would swallow the
 * first click after leaving it (Hand back would take two clicks).
 */
function useFullScreen(full: boolean, setFull: (full: boolean) => void) {
  useEffect(() => {
    if (!full) return;
    const root = document.documentElement;
    const left = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", left);
    if (typeof root.requestFullscreen === "function" && !document.fullscreenElement) {
      root.requestFullscreen().catch(() => {});
    }
    return () => {
      document.removeEventListener("fullscreenchange", left);
      if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
    };
  }, [full, setFull]);
}

/** What of the full-screen bar shows: all of it, the head alone, or nothing. */
type BarShown = "all" | "head" | "none";

/**
 * Full screen on the agent's screen: what shows of the dialog's head, a bar over the screen, and what floats under
 * it. All of it as full screen starts, on any pointer move or tap while watching, and on a tap in control (a phone
 * has no pointer to bring to the edge); in control, the head alone once the pointer rests at the top edge, which
 * leaves the computer's own top bar as clear as it can. It stays while the pointer is on it and hides 2.5 s after
 * the last ask. A banner, or keyboard focus in it, keeps it (computer.css).
 */
function useBar(on: boolean, control: boolean): BarShown {
  const [shown, setShown] = useState<BarShown>("all");
  useEffect(() => {
    setShown("all");
    if (!on) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let edge: ReturnType<typeof setTimeout> | undefined;
    let now: BarShown = "all";
    const show = (next: BarShown) => {
      now = next;
      setShown(next);
    };
    const hideLater = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        show("none");
      }, BAR_MS);
    };
    const moved = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.(".ac-dialog__head")) {
        clearTimeout(timer);
        timer = undefined;
        if (now === "none") show("head");
      } else if (!control || e.pointerType === "touch") {
        show("all");
        hideLater();
      } else if (e.clientY > BAR_EDGE_PX) {
        clearTimeout(edge);
        edge = undefined;
        if (now !== "none" && timer === undefined) hideLater();
      } else if (edge === undefined) {
        edge = setTimeout(() => {
          edge = undefined;
          if (now === "none") show("head");
          hideLater();
        }, BAR_EDGE_MS);
      }
    };
    hideLater();
    const opts = { capture: true, passive: true };
    document.addEventListener("pointermove", moved, opts);
    document.addEventListener("pointerdown", moved, opts);
    return () => {
      clearTimeout(timer);
      clearTimeout(edge);
      document.removeEventListener("pointermove", moved, opts);
      document.removeEventListener("pointerdown", moved, opts);
    };
  }, [on, control]);
  return on ? shown : "all";
}

/**
 * "Pronto" for a moment when the computer it was waiting for gets ready, then it opens by itself. A hold also
 * ends the wait's stage, and the computer isn't ready then.
 */
function useReadyFlash(surface: ComputerSurface | null) {
  const [flashing, setFlashing] = useState(false);
  const was = useRef(surface);
  useEffect(() => {
    if (was.current === "preparing" && surface && surface !== "preparing" && surface !== "held") setFlashing(true);
    was.current = surface;
  }, [surface]);
  useEffect(() => {
    if (!flashing) return;
    const id = setTimeout(() => setFlashing(false), READY_FLASH_MS);
    return () => clearTimeout(id);
  }, [flashing]);
  return flashing;
}

/**
 * The dialog. Closing it in control of a take over hands it back at once; the agent's own request keeps its
 * 2 minutes of grace, and says so. Full screen on the agent's screen shows that screen alone, the head a bar over
 * it. Esc: in control it goes to the computer; in full screen it leaves full screen, except in control on Chromium,
 * where holding it does; otherwise it closes.
 */
export function ComputerDialog({ agent, open, onClose }: { agent: Agent; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const actions = useBrowserHandoffMutations(org.id);
  const [poll, setPoll] = useState<number | false>(POLL_MS);
  const view = useAgentComputer(agent, { poll: open ? poll : false, runs: true });
  const surface = view.facts ? surfaceOf(view.facts) : null;
  useEffect(() => setPoll(surface === "screen" ? false : surface === "page" ? PAGE_POLL_MS : POLL_MS), [surface]);
  const [sub, setSub] = useState<HTMLElement | null>(null);
  const [acts, setActs] = useState<HTMLElement | null>(null);
  const [full, setFull] = useState(false);
  useFullScreen(full, setFull);
  const g = agentGrammar(t, agent.name);
  const handoff = view.facts?.handoff ?? null;
  const mine = controlledBy(handoff, me.user.id);
  const screenOnly = full && surface === "screen";
  const bar = useBar(screenOnly, mine);
  const locked = useKeyboardLock(screenOnly && mine);
  const color = colorOf(agent);
  // An action that failed, in place of the sub-line for a moment (`useSayFailed`).
  const { said, say } = useSaid();
  const close = () => {
    setFull(false);
    onClose();
    if (!mine || !handoff) return;
    // The dialog is gone by the time the answer comes: a promise, not the mutation's own callbacks.
    if (handoff.kind === "takeover") {
      actions.done.mutateAsync(handoff.id).then(
        () => toast.show(t("browser.now.handedBack", g)),
        () => toast.show(t("browser.live.actionFailed"), "error"),
      );
    } else toast.show(t("agentComputer.closeAsk", g));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title={t("agentComputer.title", g)}
      leading={<AgentAvatar agentId={agent.id} name={agent.name} size="sm" />}
      subtitle={
        <>
          {said && (
            <span key={said.at} className="cmp-said ac-iconline" role="alert">
              <Icon name="alert" size={14} />
              <span>{said.text}</span>
            </span>
          )}
          <span ref={setSub} className="cmp-sub" hidden={said !== null} />
        </>
      }
      actions={<span ref={setActs} className="cmp-acts" />}
      closeLabel={t("common.close")}
      width={1280}
      className={cx(
        "cmp-dialog",
        full && "is-full",
        screenOnly && "is-screen-only",
        bar === "none" && "is-bar-hidden",
        bar !== "all" && "is-line-hidden",
      )}
      onEscapeKeyDown={(e) => {
        // Keyboard Lock in control: Esc is the computer's; holding it leaves full screen, as the browser says.
        if (locked.current && document.fullscreenElement) e.preventDefault();
        else if (full) {
          e.preventDefault();
          setFull(false);
        } else if (mine) e.preventDefault();
      }}
    >
      <SkyStrip color={color} muted={mine} moving={Boolean(view.facts?.working) && !mine} />
      <ComputerStage
        agent={agent}
        view={view}
        surface={surface}
        slots={{ sub, actions: acts, full, setFull, say: (text) => say(text, true) }}
        onLeave={close}
      />
    </Dialog>
  );
}

/** What the stage shows, by `surfaceOf`, with the banners over a live one. */
function ComputerStage({
  agent,
  view,
  surface,
  slots,
  onLeave,
}: {
  agent: Agent;
  view: AgentComputerView;
  surface: ComputerSurface | null;
  slots: Omit<DialogHeadSlots, "watching">;
  /** Going to the agent's page from here closes the dialog. */
  onLeave: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useBrowserHandoffMutations(org.id);
  const navigate = useNavigate();
  const outages = useMachineOutages(org.id, can(org.role, "manage_agents"));
  const [switching, setSwitching] = useState(false);
  // The screen's own held cover says it all: no pause line over it.
  const [screenHeld, setScreenHeld] = useState(false);
  const f = view.facts;
  const g = agentGrammar(t, agent.name);
  const color = colorOf(agent);
  const waitingFor = f?.handoff && isWaitingHandoff(f.handoff) ? f.handoff : null;
  const now = useNow(waitingFor ? 15_000 : false);
  const flashing = useReadyFlash(surface);
  const reader = useWaitReader();
  const machine = view.machine;
  const computer = computerName(t, org.name, machine);
  const manages = can(org.role, "manage_agents") || agent.ownerUserId === me.user.id;
  const person = (id: string | null) => (id ? dir.memberById.get(id)?.name : undefined) ?? t("channel.unknownPerson");
  const paused = f?.edition === "selfhost" && machine && isPaused(machine, now) ? machine.paused : null;
  const waiting = waitingFor && isWaitingHandoff(waitingFor, now) ? waitingFor : null;
  const mine = controlledBy(f?.handoff, me.user.id);
  const watching = f
    ? liveSubLine(t, f, { name: agent.name, computer, person, nowMs: now })
    : t("agentComputer.sub.watching");
  const head: DialogHeadSlots = { ...slots, watching };
  const refused = (err: unknown) =>
    slots.say((err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"));
  const help = () => waiting && actions.takeControl.mutate(waiting.id, { onError: refused });
  const takeBrowser = () => actions.takeover.mutate(agent.id, { onError: refused });
  const retry = () => void view.desktopQ.refetch();
  const canTakeOver = !f?.held && !paused && !waiting;
  const goTo = (search: { tab: "access" } | { tab: "settings"; sec: "computer" }) => {
    onLeave();
    void navigate({ to: "/org/$orgId/agents/$agentId", params: { orgId: org.id, agentId: agent.id }, search });
  };
  const openTools = () => goTo({ tab: "access" });
  const choose = () => goTo({ tab: "settings", sec: "computer" });

  let body: ReactNode;
  let steps: ReactNode = null;
  if (!f || !view.ready) {
    body = (
      <>
        <DialogHead sub={t("agentComputer.sub.opening")} />
        <Stage>
          <Cover color={color} sky spinner text={t("agentComputer.state.opening", g)} />
        </Stage>
      </>
    );
  } else if (view.forbidden) {
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover color={color} icon="lock" text={t("agentComputer.state.forbidden")} />
        </Stage>
      </>
    );
  } else if (flashing) {
    body = (
      <>
        <DialogHead sub={t("agentComputer.state.ready")} />
        <Stage>
          <Cover color={color} sky icon="check" text={t("agentComputer.state.ready")} />
        </Stage>
      </>
    );
  } else if (surface === "held") {
    body = (
      <>
        <DialogHead sub={t("agentComputer.sub.held")} />
        <Stage>
          <Cover
            color={color}
            icon="pause"
            text={t("agentComputer.state.held", g)}
            help={t("agentComputer.state.heldHelp")}
          />
        </Stage>
      </>
    );
  } else if (surface === "preparing" && f.setup) {
    body = (
      <>
        <DialogHead sub={t(f.setup.chipKey)} />
        <div className="cmp-prep">
          <ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state="paused" size={96} />
          <b className="cmp-prep__title">{t("computerSetup.notice.title", { org: org.name })}</b>
          <SetupWait view={f.setup} reader={reader} />
        </div>
      </>
    );
  } else if (surface === "screen" || surface === "page") {
    body = (
      <>
        {f.held ? (
          !(surface === "screen" && screenHeld) && (
            <Banner tone="pause" text={t("agentComputer.state.held", g)} help={t("agentComputer.state.heldHelp")} />
          )
        ) : paused ? (
          <Banner
            tone="pause"
            text={
              paused.until
                ? t("agentComputer.state.paused", { computer, time: clockAt(i18n.language, paused.until) })
                : t("agentComputer.state.pausedPlain", { computer })
            }
            help={t("machines.pausedHint")}
          />
        ) : (
          waiting && (
            <Banner
              tone="warn"
              text={
                asksMe(waiting, me.user.id)
                  ? t("agentComputer.ask.banner", {
                      ...g,
                      ask: waiting.instructions,
                      count: handoffMinutesLeft(waiting, now) ?? 0,
                    })
                  : t("agentComputer.ask.bannerOther", {
                      ...g,
                      person: person(waiting.requestedForUserId),
                      ask: waiting.instructions,
                      count: handoffMinutesLeft(waiting, now) ?? 0,
                    })
              }
              action={
                (asksMe(waiting, me.user.id) || manages) && (
                  <Button size="sm" variant="primary" loading={actions.takeControl.isPending} onClick={help}>
                    {t("agentComputer.help")}
                  </Button>
                )
              }
            />
          )
        )}
        {surface === "screen" ? (
          <DesktopView
            agentId={agent.id}
            name={agent.name}
            computer={computer}
            edition={f.edition}
            machine={machine}
            canTakeOver={canTakeOver}
            onHeld={setScreenHeld}
            {...(manages && f.browser && !view.desktop?.canControl ? { onTakeBrowser: takeBrowser } : {})}
          />
        ) : (
          <BrowserCard agentId={agent.id} name={agent.name} handoff={f.handoff} surface canTakeOver={canTakeOver} />
        )}
      </>
    );
    steps = f.working && !mine && view.steps.length > 0 && (
      <ol className="cmp-steps" aria-label={t("browser.watch.title")}>
        {view.steps.slice(-3).map((s) => (
          <li key={s.id}>{stepText(t, s, s.screen)}</li>
        ))}
      </ol>
    );
  } else if (machine && !machine.online) {
    const since = machine.lastSeenAt ? clockAt(i18n.language, machine.lastSeenAt) : null;
    const outage = outages.data?.outages.find((o) => o.machineId === machine.id);
    body =
      f.edition === "cloud" ? (
        <>
          <DialogHead sub={t("agentComputer.sub.notAnswering")} />
          <Stage>
            <Cover
              color={color}
              art={<ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state="offline" size={96} />}
              text={t("agentComputer.state.notAnswering", { computer })}
              help={
                <>
                  {t("agentComputer.state.notAnsweringHelp")} <span>{t("desktop.state.retrying")}</span>
                </>
              }
            />
          </Stage>
        </>
      ) : (
        <>
          <DialogHead sub={since ? t("agentComputer.sub.offline", { time: since }) : t("machines.offline")} />
          <Stage>
            <Cover
              color={color}
              art={<ComputerPortrait kind={computerKind(machine.os)} state="offline" size={96} />}
              text={t("agentComputer.state.offline", { computer })}
              // The head already says since when.
              help={t("agentComputer.state.offlineHelpPlain", g)}
              action={
                manages &&
                outage &&
                outages.data && (
                  <Button size="sm" onClick={() => setSwitching(true)}>
                    {t("outage.switch")}
                  </Button>
                )
              }
            />
          </Stage>
          {switching && outage && outages.data && (
            <SwitchComputerDialog open onOpenChange={setSwitching} outage={outage} data={outages.data} />
          )}
        </>
      );
  } else if (!machine && f.edition === "cloud") {
    // The workspace's computer is ready and this agent gets it at its first hello: a moment more.
    body = (
      <>
        <DialogHead sub={t("agentComputer.sub.opening")} />
        <Stage>
          <Cover color={color} sky spinner text={t("agentComputer.state.opening", g)} />
        </Stage>
      </>
    );
  } else if (!machine) {
    body = (
      <>
        <DialogHead sub={t("agentComputer.status.noComputer")} />
        <Stage>
          <Cover
            color={color}
            icon="computer"
            text={t("agentComputer.state.noComputer", g)}
            action={
              manages && (
                <Button size="sm" variant="primary" onClick={choose}>
                  {t("agentComputer.choose")}
                </Button>
              )
            }
          />
        </Stage>
      </>
    );
  } else if (view.desktop?.reason === "no_desktop" && !f.browserGranted) {
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover
            color={color}
            icon="dash"
            text={t("agentComputer.state.noScreen", g)}
            action={
              manages && (
                <Button size="sm" onClick={openTools}>
                  {t("agentComputer.openAccess")}
                </Button>
              )
            }
          />
        </Stage>
      </>
    );
  } else if (computerKind(machine.os) === "mac" && view.browserSettings?.reason === "switched_off") {
    // A Mac shows no screen, only the agent's page: what's missing is its browser, which only the Mac turns on.
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover
            color={color}
            icon="globe"
            text={t("agentComputer.state.browserOff", { ...g, computer })}
            help={t("browser.machine.offHelp")}
          />
        </Stage>
      </>
    );
  } else {
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <CantShowCover
            edition={f.edition}
            machine={machine}
            computer={computer}
            name={agent.name}
            reason={view.desktop?.reason ?? null}
            detail={view.desktop?.detail ?? null}
            color={color}
            onRetry={retry}
          />
        </Stage>
      </>
    );
  }
  return (
    <DialogHeadContext.Provider value={head}>
      <div className="cmp-body">
        {body}
        {steps && <div className="cmp-steps-row">{steps}</div>}
      </div>
    </DialogHeadContext.Provider>
  );
}

/** A line over the live stage: the agent held, its computer paused, or a request waiting for someone. */
function Banner({
  tone,
  text,
  help,
  action,
}: {
  tone: "pause" | "warn";
  text: string;
  help?: string;
  action?: ReactNode;
}) {
  return (
    <div className="cmp-banner" data-tone={tone} role="status">
      <span className="cmp-banner__t">
        <b>{text}</b>
        {help && <span>{help}</span>}
      </span>
      {action}
    </div>
  );
}

/**
 * "Computador" in the agent's DM header, for whoever may watch its computer: the same dialog, in place, with a
 * dot while the agent needs someone (amber) or works on it (its color).
 */
export function ComputerButton({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const view = useAgentComputer(agent);
  const openComputer = useOpenComputer();
  if (!view.ready || view.forbidden || !view.facts) return null;
  const f = view.facts;
  const entry = entryState(f);
  const state =
    entry.kind === "needsYou" || entry.kind === "needsOther"
      ? "waiting"
      : entry.kind === "working" || entry.kind === "you" || entry.kind === "other"
        ? "live"
        : undefined;
  const dot = { "--dot": (AGENT_GRADIENTS[colorOf(agent)] ?? AGENT_GRADIENTS.sky)[0] } as CSSProperties;
  return (
    <Button
      size="sm"
      icon="computer"
      className="brw-dm"
      data-state={state}
      style={state === "live" ? dot : undefined}
      onClick={() => openComputer(agent.id)}
    >
      <span className="brw-dm__label">{t("agentComputer.button")}</span>
      {state && (
        <span className="ac-visually-hidden">
          {entryLine(t, entry, {
            edition: f.edition,
            locale: i18n.language,
            computer: view.machine?.name ?? "",
            lastSeenAt: null,
            person: (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
            step: null,
            emailPromised: false,
          })}
        </span>
      )}
    </Button>
  );
}

/**
 * One computer dialog for the workspace: its agent page's entry, the DM's button, a computer's page and the
 * chat's cards open an agent's computer here, in place.
 */
export function ComputerDialogProvider({ children }: { children: ReactNode }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [agentId, setAgentId] = useState<string | null>(null);
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  const close = useCallback(() => setAgentId(null), []);
  return (
    <OpenComputerContext.Provider value={setAgentId}>
      {children}
      {agent && <ComputerDialog key={agent.id} agent={agent} open onClose={close} />}
    </OpenComputerContext.Provider>
  );
}
