import type { BrowserHandoff, BrowserInputEvent, BrowserStep, LiveRun } from "@agenteschat/client";
import {
  browserSiteUrl,
  browserSteps,
  clickEvents,
  controlledBy,
  frameMetadata,
  HELD_STALE_MS,
  isHeldTakeover,
  isOpenHandoff,
  keyboardEvents,
  keyEvents,
  modifiersOf,
  pagePoint,
  rememberHeldPlace,
  textEvent,
  useAgentBrowserHandoff,
  useBrowserHandoffMutations,
  useMachines,
  wheelEvent,
} from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, FilterToggle, Icon, type IconName, PixelSpinner, SkyStrip, Textarea } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useBrowserLive, useStreams } from "@/realtime/context";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { requestBrowserCard, useBrowserCardRequest } from "./open";
import "./browser.css";

const FAIL_REASONS = ["code", "password", "blocked"] as const;
const KEYS = ["Tab", "Enter", "Backspace", "Escape"] as const;
/** The keycaps of the keys popover (symbols; the key names are their labels). */
const KEYCAP: Record<(typeof KEYS)[number], string> = { Tab: "⇥", Enter: "↵", Backspace: "⌫", Escape: "esc" };

/** The nearest ancestor that scrolls (the conversation), to keep the card in place when it grows. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

const STEP_ICON = {
  browser_do: "bolt",
  browser_open: "globe",
  browser_back: "chevronLeft",
  browser_tabs: "layers",
  browser_read: "document",
  browser_click: "arrowRight",
  browser_fill: "edit",
  browser_select: "list",
  browser_check: "check",
  browser_press: "arrowRight",
  browser_scroll: "chevronDown",
  browser_upload: "upload",
  browser_type_secret: "key",
  browser_wait: "clock",
  browser_screenshot: "image",
  browser_ask_person: "person",
  browser_close: "close",
} satisfies Record<string, IconName>;

type StepTool = keyof typeof STEP_ICON;
const isStepTool = (tool: string): tool is StepTool => Object.hasOwn(STEP_ICON, tool);
export const iconOf = (tool: string): IconName => (isStepTool(tool) ? STEP_ICON[tool] : "globe");

/** One line of the log, in the person's words ("Abriu loja.exemplo", "Preencheu um campo"). */
export function stepText(t: TFunction, s: BrowserStep): string {
  if (s.tool === "browser_open")
    return s.detail
      ? t("browser.watch.step.browser_open", { detail: s.detail })
      : t("browser.watch.step.browser_open_plain");
  return isStepTool(s.tool) ? t(`browser.watch.step.${s.tool}`) : t("browser.watch.step.other");
}

const RANK: Record<BrowserHandoff["status"], number> = {
  pending: 0,
  active: 1,
  done: 2,
  failed: 2,
  expired: 2,
  cancelled: 2,
};

/** Two views of the same request (the socket's, the cache's): the one further along wins; another request, the first. */
function newest(a: BrowserHandoff | null, b: BrowserHandoff | null): BrowserHandoff | null {
  if (!a || !b) return a ?? b;
  if (a.id !== b.id) return a;
  return RANK[b.status] > RANK[a.status] ? b : a;
}

/** "https://dashboard.stripe.com/login?x=1" → ["dashboard.stripe.com", "/login"]. */
export function hostAndPath(url: string | null | undefined): [string, string] {
  if (!url) return ["", ""];
  const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  return m ? [m[1] ?? "", (m[2] ?? "").replace(/\/$/, "")] : [url, ""];
}

/**
 * What the card's title shows: the request while the person is in control of it, else the
 * site, "opening" only until the first frame, and the agent's browser when no site is known.
 */
export function titleKind(v: {
  inControl: boolean;
  ask: string | null;
  host: string;
  opening: boolean;
}): "ask" | "host" | "opening" | "agent" {
  if (v.inControl && v.ask) return "ask";
  if (v.host) return "host";
  return v.opening ? "opening" : "agent";
}

/**
 * The browser card on an agent's live row, while (and after) it used its browser in this run. A
 * take over bound to this run keeps it even without steps (a reload); a run that failed or was
 * stopped keeps it only for the person still in control (they hand back from it).
 */
export function RunBrowserCard({ run, name }: { run: LiveRun; name: string }) {
  const { org, me } = useOrg();
  const steps = browserSteps(run.work);
  const ended = run.status === "failed" || run.status === "canceled";
  const ask = !run.provisional && (ended || steps.length === 0);
  const open = useAgentBrowserHandoff(org.id, run.agentId, ask, HELD_STALE_MS);
  const held = isHeldTakeover(open.data, run.runId);
  if (ended ? !(held && controlledBy(open.data, me.user.id)) : steps.length === 0 && !held) return null;
  return (
    <BrowserCard
      agentId={run.agentId}
      name={name}
      steps={steps}
      runId={run.runId}
      place={{ channelId: run.channelId, threadId: run.threadId }}
      handoff={held ? (open.data ?? null) : null}
      defaultOpen={held && controlledBy(open.data, me.user.id)}
    />
  );
}

/**
 * A take over held after its run's live block went (the run paused for the person, or ended): the
 * same card, on the run's last saved message or at the end of its conversation, until the browser
 * is handed back (telas/NavegadorNoChat.html: "Assumir pausa o agente e abre a tela ao vivo").
 * Nothing while the run's live block is there (it draws the card) or when no take over holds it.
 */
export function HeldBrowserCard({
  agentId,
  runId,
  name,
  enabled = true,
}: {
  agentId: string;
  runId: string;
  name: string;
  /** Ask the server (a recent message); otherwise only what the realtime events said. */
  enabled?: boolean;
}) {
  const { me } = useOrg();
  const held = useHeldTakeover(agentId, runId, enabled);
  if (!held) return null;
  return (
    <BrowserCard
      agentId={agentId}
      name={name}
      runId={runId}
      handoff={held}
      defaultOpen={controlledBy(held, me.user.id)}
    />
  );
}

/** The agent's open take over bound to this run, while the run has no live block here (`HeldBrowserCard`). */
export function useHeldTakeover(agentId: string, runId: string, enabled = true): BrowserHandoff | null {
  const { org } = useOrg();
  const open = useAgentBrowserHandoff(org.id, agentId, enabled, HELD_STALE_MS);
  const liveHere = useStreams((s) => Boolean(s.runs[runId]));
  return !liveHere && open.data && isHeldTakeover(open.data, runId) ? open.data : null;
}

const lowerFirst = (s: string, lang: string) => (s ? s.charAt(0).toLocaleLowerCase(lang) + s.slice(1) : s);

/**
 * An agent's browser in its card in the conversation (telas/NavegadorNoChat.html, A with the
 * "Céu" header; ADR 0040 §6–7). Closed: one line with the agent's sky edge, the site and what
 * it does now. Open: the same line over the live page and its steps. In control (Assumir, or
 * a help request opened here) the same card takes the person's clicks and the app's own text
 * field, and Pronto in the header hands back. Nothing leaves the chat.
 */
export function BrowserCard({
  agentId,
  name,
  steps = [],
  handoff: given = null,
  defaultOpen = false,
  onSettled,
  runId,
  place,
}: {
  agentId: string;
  name: string;
  /** What the agent did in its browser in this run (the log); none outside a run. */
  steps?: BrowserStep[];
  /** The run whose card this is: Assumir binds the take over to it (the card stays in its conversation). */
  runId?: string;
  /** Where that run answers (the held card's place once its live block goes). */
  place?: { channelId: string; threadId: string | null };
  /** The help request this card answers (opened from it). */
  handoff?: BrowserHandoff | null;
  defaultOpen?: boolean;
  /** The person handed back or said it couldn't be done: the holder can fold the card away. */
  onSettled?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const agent = dir.agentById.get(agentId);
  const g = agentGrammar(t, name);
  const color = colorOf(agent);
  const [open, setOpenState] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  // Opening or closing by hand keeps the card where it is on screen: the conversation doesn't jump.
  const anchor = useRef<number | null>(null);
  const setOpen = (next: boolean | ((v: boolean) => boolean)) => {
    anchor.current = root.current?.getBoundingClientRect().top ?? null;
    setOpenState(next);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each open/close to restore the card's place
  useLayoutEffect(() => {
    const before = anchor.current;
    anchor.current = null;
    if (before === null || !root.current) return;
    const scroller = scrollerOf(root.current);
    if (scroller) scroller.scrollTop += root.current.getBoundingClientRect().top - before;
  }, [open]);
  // The small live picture streams only while the card is on screen; off screen it keeps the last frame.
  // Except for the person in control: their watching is what keeps their control (2 min without it ends it).
  const [visible, setVisible] = useState(false);
  const [holding, setHolding] = useState(() => controlledBy(given, me.user.id));
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const live = useBrowserLive(agentId, open || visible || holding);
  const [still, setStill] = useState<typeof live.frame>(null);
  useEffect(() => {
    if (live.frame) setStill(live.frame);
  }, [live.frame]);
  const openQ = useAgentBrowserHandoff(org.id, agentId, open);
  const actions = useBrowserHandoffMutations(org.id);
  const machines = useMachines(org.id);
  const imgRef = useRef<HTMLImageElement>(null);

  const handoff = newest(
    live.status?.handoff ?? null,
    newest(openQ.data ?? null, given && isOpenHandoff(given) ? given : null),
  );
  const controller = handoff?.status === "active" ? handoff.controllerUserId : null;
  const inControl = controller === me.user.id;
  const otherInControl = Boolean(controller) && !inControl;
  useEffect(() => setHolding(inControl), [inControl]);
  const controllerName = controller ? (dir.memberById.get(controller)?.name ?? t("channel.unknownPerson")) : "";
  // The computer the browser runs on: the request's, else the one this agent works on.
  const machine = (machines.data ?? []).find((m) =>
    handoff?.machineId ? m.id === handoff.machineId : m.agents.some((a) => a.id === agentId),
  );
  const remoteIsMac = machine?.os === "darwin";

  const [secure, setSecure] = useState(false);
  const [text, setText] = useState("");
  const [mark, setMark] = useState<{ x: number; y: number; key: number } | null>(null);
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState<(typeof FAIL_REASONS)[number] | null>(null);
  const [note, setNote] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  // The wheel scrolls the conversation; a click into the page (in control) hands it to the page until Esc.
  const [capturing, setCapturing] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);

  // The bar or a notification asked for this card: open it here and bring it into view.
  const asked = useBrowserCardRequest({ agentId, ...(given ? { handoffId: given.id } : {}) });
  useEffect(() => {
    if (asked === null) return;
    // Asked from elsewhere: it scrolls into view on purpose (no keeping in place here).
    setOpenState(true);
    root.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [asked]);

  const send = (events: BrowserInputEvent[] | null) => {
    if (!inControl || !events?.length) return;
    live.sendInput(events);
  };

  const onPageClick = (e: MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    const meta = live.frame ? frameMetadata(live.frame) : undefined;
    if (!inControl || !img || !meta) return;
    const box = img.getBoundingClientRect();
    const at = pagePoint({ x: e.clientX, y: e.clientY }, box, meta);
    if (!at) return;
    setCapturing(true);
    setMark({ x: e.clientX - box.left, y: e.clientY - box.top, key: Date.now() });
    send(clickEvents(at, modifiersOf(e, remoteIsMac)));
  };

  // Only a page that was clicked into takes the wheel (a native listener: the conversation's scroll is
  // stopped only then); anywhere else the wheel scrolls the conversation.
  const wheelTo = useRef<(e: globalThis.WheelEvent) => void>(() => {});
  wheelTo.current = (e) => {
    const img = imgRef.current;
    const meta = live.frame ? frameMetadata(live.frame) : undefined;
    if (!capturing || !inControl || !img || !meta) return;
    e.preventDefault();
    const at = pagePoint({ x: e.clientX, y: e.clientY }, img.getBoundingClientRect(), meta);
    if (at) send([wheelEvent(at, e.deltaX, e.deltaY)]);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page element mounts with the open card
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const on = (e: globalThis.WheelEvent) => wheelTo.current(e);
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [open, Boolean(live.frame)]);
  useEffect(() => {
    if (!capturing) return;
    const out = (e: PointerEvent) => {
      if (!pageRef.current?.contains(e.target as Node)) setCapturing(false);
    };
    document.addEventListener("pointerdown", out, true);
    return () => document.removeEventListener("pointerdown", out, true);
  }, [capturing]);
  useEffect(() => {
    if (!inControl || !open) setCapturing(false);
  }, [inControl, open]);

  const onPageKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!inControl) return;
    if (capturing && e.key === "Escape") {
      e.preventDefault();
      setCapturing(false);
      return;
    }
    const events = keyboardEvents(e, remoteIsMac);
    if (!events) return;
    e.preventDefault();
    send(events);
  };

  const sendText = () => {
    const ev = textEvent(text);
    if (!ev) return;
    send([ev]);
    setText("");
  };

  const failedToast = () => toast.show(t("browser.live.actionFailed"), "error");

  const finish = () => {
    if (!handoff) return;
    actions.done.mutate(handoff.id, {
      onSuccess: () => {
        setOpen(false);
        onSettled?.();
      },
      onError: failedToast,
    });
  };

  const fail = () => {
    if (!handoff) return;
    const words = [reason ? t(`browser.live.failReasons.${reason}`) : "", note.trim()].filter(Boolean).join(". ");
    actions.failed.mutate(
      { handoffId: handoff.id, ...(words ? { note: words } : {}) },
      {
        onSuccess: () => {
          setFailing(false);
          setOpen(false);
          onSettled?.();
        },
        onError: failedToast,
      },
    );
  };

  const takeover = () => {
    setOpen(true);
    actions.takeover.mutate(runId ? { agentId, runId } : agentId, {
      onSuccess: (h) => {
        // It claimed the agent's own request: that request's card is the control (one card, not two).
        if (h.kind === "ask") requestBrowserCard({ agentId, handoffId: h.id });
        else if (h.runId && place) rememberHeldPlace({ runId: h.runId, agentId, ...place });
      },
      onError: (err) =>
        toast.show(
          (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.live.actionFailed"),
          "error",
        ),
    });
  };

  const stop = () =>
    actions.stop.mutate(agentId, {
      onSuccess: () => {
        setConfirmStop(false);
        setOpen(false);
        setStoppedAt(new Date().toISOString());
      },
      onError: failedToast,
    });

  // The agent's own request is open and mine: its card (under the request) is the control, not this one.
  if (!given && handoff?.kind === "ask" && inControl) return null;

  // Parar (here, or by someone else: everyone watching hears it), or the browser closed on its own.
  const stopped = stoppedAt
    ? { at: stoppedAt, by: me.user.id }
    : live.endedBy?.reason === "stopped"
      ? { at: live.endedBy.at ?? null, by: live.endedBy.userId ?? null }
      : null;
  if (stopped || live.ended) {
    const byName = stopped?.by && stopped.by !== me.user.id ? dir.memberById.get(stopped.by)?.name : undefined;
    const time = stopped?.at ? formatTime(i18n.language, stopped.at) : "";
    return (
      <div className="brw-ac" ref={root}>
        <div className="brw-ac__head">
          <span className="brw-stile brw-stile--lg" aria-hidden="true">
            <Icon name="stop" size={14} />
          </span>
          <span className="brw-ac__tx">
            <b>{stopped ? t("browser.watch.stopped") : t("browser.live.ended", g)}</b>
            {stopped && (stopped.by === me.user.id || byName || time) && (
              <small>
                <span>
                  {stopped.by === me.user.id
                    ? t("browser.watch.stoppedBy", { time })
                    : byName
                      ? t("browser.watch.stoppedByOther", { person: byName, time })
                      : t("browser.watch.stoppedAt", { time })}
                </span>
              </small>
            )}
          </span>
          {inControl && handoff && (
            <span className="brw-ac__acts">
              <Button size="sm" variant="primary" icon="check" loading={actions.done.isPending} onClick={finish}>
                {t("browser.inCard.done")}
              </Button>
            </span>
          )}
        </div>
      </div>
    );
  }

  const frame = live.frame;
  const unavailable = live.unavailable;
  const reconnecting = unavailable?.reason === "reconnecting";
  // What can't change by waiting is said plainly; everything else is "opening" while it retries.
  const blocker =
    unavailable?.reason === "offline"
      ? t("browser.inCard.offline", g)
      : unavailable?.reason === "no_computer"
        ? t("browser.inCard.noComputer", g)
        : unavailable?.reason === "forbidden" || live.error === "forbidden" || live.error === "not_found"
          ? t("browser.inCard.forbidden")
          : null;
  const starting = open && !frame && !blocker && !reconnecting;
  const src = frame ? `data:image/jpeg;base64,${frame.data}` : null;
  const lastStep = steps.at(-1);
  const [host, path] = hostAndPath(browserSiteUrl((frame ?? still)?.metadata.url, steps));
  const ask = handoff?.kind === "ask" ? handoff.instructions : null;
  const working = !inControl && !otherInControl;
  const showLog = open && working && !starting && steps.length > 0;

  const asTitle = titleKind({ inControl, ask, host, opening: open && starting });
  const title =
    asTitle === "ask"
      ? (ask ?? "")
      : asTitle === "host"
        ? host
        : asTitle === "opening"
          ? t("browser.inCard.opening")
          : t("browser.inCard.group", g);
  const sub = inControl
    ? ask
      ? host
        ? t("browser.inCard.subControl", { site: host, ...g })
        : t("browser.inCard.subControlAsked", g)
      : t("browser.inCard.subTakeover", g)
    : otherInControl
      ? t("browser.inCard.subOther", { person: controllerName })
      : reconnecting
        ? t("browser.inCard.subReconnect", g)
        : (open && starting) || !lastStep
          ? t("browser.inCard.subStarting", g)
          : t("browser.inCard.subWorking", { name, now: lowerFirst(stepText(t, lastStep), i18n.language) });
  const live_ = working && !blocker;
  const toggleLabel = open ? t("browser.inCard.collapse") : t("browser.inCard.expand");
  const thumb = frame ?? still;
  const thumbSrc = thumb ? `data:image/jpeg;base64,${thumb.data}` : null;

  // Watching: Assumir (a labelled, tactile button) and Parar (quiet, with a confirmation), never a lone red square.
  const watchActs = confirmStop ? (
    <>
      <span className="small muted">{t("browser.watch.stopAsk")}</span>
      <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
        {t("browser.watch.no")}
      </Button>
      <Button size="sm" variant="primary" loading={actions.stop.isPending} onClick={stop}>
        {t("browser.inCard.stop")}
      </Button>
    </>
  ) : (
    !otherInControl &&
    !blocker && (
      <>
        <Button size="sm" icon="person" loading={actions.takeover.isPending} onClick={takeover}>
          {t("browser.inCard.takeover")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="stop"
          aria-label={t("browser.inCard.stop")}
          title={t("browser.inCard.stop")}
          onClick={() => setConfirmStop(true)}
        />
      </>
    )
  );
  const controlActs = (
    <>
      {ask && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(true);
            setFailing(true);
          }}
        >
          {t("browser.inCard.giveUp")}
        </Button>
      )}
      <Button size="sm" variant="primary" icon="check" loading={actions.done.isPending} onClick={finish}>
        {t("browser.inCard.done")}
      </Button>
    </>
  );
  const titleText = (
    <b className={asTitle === "ask" ? "is-ask" : undefined} title={asTitle === "ask" ? title : undefined}>
      {title}
      {asTitle === "host" && path && <span className="brw-ac__path">{path}</span>}
    </b>
  );
  const subText = (
    <small>
      {(live_ || reconnecting) && <PixelSpinner size={14} color={color} />}
      <span>{sub}</span>
    </small>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      ref={root}
      className={["brw-ac", open && "is-open", inControl && "is-control"].filter(Boolean).join(" ")}
      role="group"
      aria-label={t("browser.inCard.group", g)}
    >
      <SkyStrip color={color} muted={inControl} moving={live_} />
      {!open ? (
        // Closed: the small live picture, the site, what the agent does now; a click opens it right here.
        <div className="brw-ac__compact">
          <button
            type="button"
            className="brw-ac__thumb"
            aria-label={toggleLabel}
            tabIndex={-1}
            onClick={() => setOpen(true)}
          >
            {thumbSrc ? <img src={thumbSrc} alt="" draggable={false} /> : <span className="brw-ac__thumb-blank" />}
          </button>
          <button type="button" className="brw-ac__tt" aria-expanded={false} onClick={() => setOpen(true)}>
            <span className="brw-ac__tx">
              {titleText}
              {subText}
              <span className="brw-ac__hint">{t("browser.inCard.expandHint")}</span>
            </span>
          </button>
          <span className="brw-ac__acts">{inControl ? controlActs : watchActs}</span>
        </div>
      ) : (
        <div className="brw-ac__head">
          <button type="button" className="brw-ac__tt" aria-expanded onClick={() => setOpen(false)}>
            <span className="brw-ac__tx">
              {titleText}
              {subText}
            </span>
          </button>
          <span className="brw-ac__acts">
            {inControl ? controlActs : watchActs}
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="chevronDown"
              className="brw-ac__chev"
              aria-label={toggleLabel}
              title={toggleLabel}
              aria-expanded
              onClick={() => setOpen(false)}
            />
          </span>
        </div>
      )}

      {open && (
        <>
          <div className={showLog ? "brw-ac__body brw-ac__body--split" : "brw-ac__body"}>
            <div className="brw-ac__stage">
              {src ? (
                // biome-ignore lint/a11y/noStaticElementInteractions: the page takes the person's keys while in control
                <div
                  ref={pageRef}
                  className={["brw-ac__page", inControl && "is-control", capturing && "is-capturing"]
                    .filter(Boolean)
                    .join(" ")}
                  tabIndex={inControl ? 0 : -1}
                  onKeyDown={onPageKey}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData("text");
                    if (pasted) {
                      e.preventDefault();
                      send([{ kind: "text", text: pasted }]);
                    }
                  }}
                >
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys go through the page's own handler above */}
                  <img ref={imgRef} src={src} alt={t("browser.live.page", g)} draggable={false} onClick={onPageClick} />
                  {mark && <span key={mark.key} className="brw-mark" style={{ left: mark.x, top: mark.y }} />}
                  {capturing && (
                    <span className="brw-ac__capture" role="status">
                      {t("browser.inCard.scrollHint")}
                    </span>
                  )}
                </div>
              ) : (
                <div className="brw-ac__page brw-ac__page--blank" aria-hidden="true">
                  <span className="brw-skel">
                    <i style={{ width: "40%" }} />
                    <i style={{ width: "70%" }} />
                    <i style={{ width: "55%" }} />
                    <i className="brw-skel__field" />
                    <i className="brw-skel__field" />
                  </span>
                </div>
              )}
              {(starting || reconnecting || blocker) && (
                <div className="brw-dim">
                  <span className="brw-dim__box" role="status">
                    <span className="brw-dim__row">
                      {!blocker && <PixelSpinner size={16} color={color} />}
                      {blocker ?? (reconnecting ? t("browser.live.reconnecting") : t("browser.inCard.openingLong", g))}
                    </span>
                    {!blocker && (
                      <small>
                        {reconnecting ? t("browser.inCard.reconnectHelp", g) : t("browser.inCard.openingHelp")}
                      </small>
                    )}
                  </span>
                </div>
              )}
            </div>
            {showLog && (
              <ol className="brw-log">
                {steps.slice(-5).map((s, i, all) => {
                  const now = i === all.length - 1 && s.running;
                  return (
                    <li key={s.id} className={now ? "is-now" : undefined}>
                      {now ? <PixelSpinner size={14} color={color} /> : <Icon name={iconOf(s.tool)} size={14} />}
                      <span>{stepText(t, s)}</span>
                      {s.since && <small>{formatTime(i18n.language, new Date(s.since).toISOString())}</small>}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          {inControl &&
            (failing ? (
              <div className="brw-ac__foot brw-ac__fail">
                <b>{t("browser.live.failTitle")}</b>
                <span className="small muted">{t("browser.live.failHelp", g)}</span>
                <div className="brw-reasons">
                  {FAIL_REASONS.map((r) => (
                    <FilterToggle key={r} pressed={reason === r} onPressedChange={(on) => setReason(on ? r : null)}>
                      {t(`browser.live.failReasons.${r}`)}
                    </FilterToggle>
                  ))}
                </div>
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("browser.live.failPlaceholder")}
                  rows={2}
                  maxLength={900}
                />
                <div className="brw-ac__row">
                  <span className="brw-grow" />
                  <Button size="sm" variant="ghost" onClick={() => setFailing(false)}>
                    {t("browser.live.back")}
                  </Button>
                  <Button size="sm" variant="primary" loading={actions.failed.isPending} onClick={fail}>
                    {t("browser.live.failSend", g)}
                  </Button>
                </div>
              </div>
            ) : (
              // One quiet field like the message composer: where the text goes, the field, Senha, Teclas, send.
              <div className="brw-ac__foot brw-type">
                {keysOpen && (
                  // biome-ignore lint/a11y/useSemanticElements: a small row of keys, not a form fieldset
                  <div className="brw-keycaps" role="group" aria-label={t("browser.inCard.keysLabel")}>
                    {KEYS.map((key) => (
                      <button
                        key={key}
                        type="button"
                        className="brw-kc"
                        aria-label={t(`browser.live.keys.${key}`)}
                        title={t(`browser.live.keys.${key}`)}
                        onClick={() => send(keyEvents(key))}
                      >
                        {KEYCAP[key]}
                      </button>
                    ))}
                  </div>
                )}
                <label className="brw-tfield">
                  <span className={mark ? "brw-tfield__to is-marked" : "brw-tfield__to"}>
                    <Icon name="pointer" size={14} />
                    {mark ? t("browser.inCard.targetMarked") : t("browser.inCard.targetNone")}
                  </span>
                  <input
                    type={secure ? "password" : "text"}
                    placeholder={
                      secure ? t("browser.inCard.typePlaceholderSecret") : t("browser.inCard.typePlaceholder")
                    }
                    aria-label={t("browser.live.typeLabel")}
                    autoComplete={secure ? "current-password" : "off"}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        sendText();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="lock"
                    className="brw-tfield__tool"
                    aria-pressed={secure}
                    aria-label={secure ? t("browser.inCard.secureOn") : t("browser.inCard.secureOff")}
                    title={secure ? t("browser.inCard.secureOn") : t("browser.inCard.secureOff")}
                    onClick={() => setSecure((v) => !v)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="keyboard"
                    className="brw-tfield__tool"
                    aria-pressed={keysOpen}
                    aria-label={t("browser.inCard.keysLabel")}
                    title={t("browser.inCard.keysLabel")}
                    onClick={() => setKeysOpen((v) => !v)}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    iconOnly
                    icon="send"
                    className="brw-tfield__send"
                    aria-label={t("browser.live.send")}
                    title={t("browser.live.send")}
                    disabled={!text}
                    onClick={sendText}
                  />
                </label>
              </div>
            ))}
          {otherInControl && (
            <div className="brw-ac__foot">
              <span className="small muted">{t("browser.inCard.otherHelp", { person: controllerName })}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
