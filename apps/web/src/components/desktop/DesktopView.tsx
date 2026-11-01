import type { DesktopMode, DesktopViewState, Edition, Machine } from "@agenteschat/client";
import {
  ApiError,
  DESKTOP_CLOSE,
  desktopCloseState,
  desktopMode,
  desktopRetryMs,
  desktopSocketUrl,
  desktopStatusState,
  useBrowserHandoffMutations,
  useDesktopStatus,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { quoteExcerpt } from "@agenteschat/client/lib/reply";
import { Button, cx, Icon, InfoHint, onScreenKeyboard, Textarea } from "@agenteschat/ui";
import type RFB from "@novnc/novnc";
import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { matchesNow, useMatchMedia } from "@/hooks/useMatchMedia";
import { heldPicture, holdPicture, liveCanvas, showsPicture } from "@/lib/canvas";
import { useSaid } from "@/lib/toast";
import { SocketFactoryContext } from "@/realtime/context";
import { Cover } from "../browser/BrowserCard";
import { CantShowCover, ScreenNotice } from "../computer/covers";
import { DialogHead, FullButton, useDialogHead, useHandBack, useSayFailed } from "../computer/head";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { DesktopLink } from "./link";
import { useScreenKeys } from "./screen-keys";
import "../browser/browser.css";
import "./desktop.css";

/** Its state settles: live, or only a person's own step changes it. */
const SETTLED: DesktopViewState[] = ["live", "forbidden", "unavailable", "outdated", "ended", "noRoom"];

/**
 * "Live" waits for the screen's first picture: one that just started is black for a few seconds, until its desktop
 * draws. How often it's looked at, and how long at most before it's shown as it is (a screen black for good). The
 * cover over the screen takes the person's clicks until then: looked at often, it lifts as the picture comes.
 */
const PICTURE_POLL_MS = 50;
const PICTURE_WAIT_MS = 10_000;
/**
 * Handing back opens the screen again as a watcher, on a new socket. Its last picture stays over the new connection
 * until that one draws (`holdPicture`), so the hand back shows no "Abrindo…" and the head says watching as soon as
 * the server does. A connection that hasn't drawn by this long is said to be opening. Taking control holds the picture
 * too, frosted under "Assumindo o controle…" for as long as control takes to open: noVNC drops keys, clicks and pastes
 * until its connection opens, so the picture must never look ready meanwhile. Once it opens, the picture stays clear
 * until control draws, and the pointer goes through it: a first click waits for nothing more than a first key.
 */
const HOLD_MS = 3_000;
/** A stream that changes mode in place and hasn't this long after the mode changed opens again in the new one. */
const SWITCH_WAIT_MS = 3_000;

/** A phone or tablet: a Keyboard button raises its keyboard. */
const TOUCH = "(pointer: coarse)";

/**
 * An agent's screen, live (ADR 0058), as the computer dialog's stage: noVNC on a socket of its own, which
 * starts a screen that isn't running. Watching is view-only at quality 3; in control (the screen's own
 * handoff is this person's) it takes the pointer and the keys at quality 6, with the person's own copy and
 * paste (`useScreenKeys`). While someone else is in control the screen stays hidden; it opens again by itself
 * after drops, restarts and hand backs. Its sub-line and actions go in the dialog's head.
 */
export function DesktopView({
  agentId,
  name,
  computer,
  edition,
  machine,
  canTakeOver,
  onTakeBrowser,
  onSettled,
  onHeld,
}: {
  agentId: string;
  name: string;
  /** The computer's name ("O Mac mini já mostra o máximo de telas…"). */
  computer: string;
  edition: Edition;
  /** The agent's computer, for the fix of a screen that can't show (its admins and whoever paired it). */
  machine: Machine | null;
  /** Take control may show: no hold, pause or request waiting (the server still decides who may). */
  canTakeOver: boolean;
  /** Whoever may take over the agent's browser but not its screen takes the browser instead. */
  onTakeBrowser?: () => void;
  /** The person handed back or said it couldn't be done. */
  onSettled?: () => void;
  /** Whether the held cover shows (the agent held and its screen not running), for the dialog's own pause line. */
  onHeld?: (held: boolean) => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const head = useDialogHead();
  const sayFailed = useSayFailed();
  const createSocket = useContext(SocketFactoryContext);
  const actions = useBrowserHandoffMutations(org.id);
  const g = agentGrammar(t, name);
  const color = colorOf(dir.agentById.get(agentId));
  const [view, setView] = useState<DesktopViewState>("connecting");
  const [round, setRound] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const [handingBack, setHandingBack] = useState(false);
  // Control opening over the last picture it watched (`HOLD_MS`).
  const [taking, setTaking] = useState(false);
  const [backNote, setBackNote] = useState("");
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const touch = useMatchMedia(TOUCH);
  const [typing, setTyping] = useState(false);
  const attempts = useRef(0);
  // Nothing says when a screen is handed back: asked often while it may change any moment.
  const [poll, setPoll] = useState(5_000);
  const status = useDesktopStatus(org.id, agentId, { poll });
  const s = status.data;
  const blocked: DesktopViewState | null = s
    ? desktopStatusState(s, me.user.id)
    : status.error instanceof ApiError && status.error.status === 403
      ? "forbidden"
      : status.isError
        ? "unavailable"
        : "connecting";
  const mode = s ? desktopMode(s, me.user.id) : "watch";
  // The mode as a connection ends: a hand back keeps its picture (`holdPicture`).
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const inControl = mode === "control";
  // The screen's socket, and the mode it opened in.
  const linkRef = useRef<DesktopLink | null>(null);
  const openedIn = useRef(mode);
  // The mode of noVNC's session now, which the server's switch changes.
  const [screenMode, setScreenMode] = useState<DesktopMode | null>(null);
  const connect = blocked === null && !gaveUp;
  const { refetch } = status;
  const didntWork = () => sayFailed(t("browser.live.actionFailed"));
  // What the clipboard just did, in the line under the screen in place of its words.
  const { said, say, unsay } = useSaid();
  const copied = () => say(t("desktop.clipboard.copied", g));
  const copyFailed = () => say(t("browser.live.actionFailed"), true);
  // What the computer copied when the browser kept it out of the person's clipboard: the line under the screen
  // offers it until they copy it, copy again or hand back.
  const [got, setGot] = useState<string | null>(null);
  const copyGot = (text: string) =>
    navigator.clipboard?.writeText(text).then(() => {
      setGot(null);
      copied();
    }, copyFailed) ?? copyFailed();
  const copiedThere = useScreenKeys({
    field: keysRef,
    screen: screenRef,
    rfb: rfbRef,
    active: inControl,
    onRefused: (why) =>
      say(why === "tooLong" ? t("desktop.clipboard.tooLong", g) : t("desktop.clipboard.textOnly", g), true),
    onCopied: (text, written) => {
      setGot(written ? null : text);
      // The newest copy speaks: what is offered to copy isn't hidden behind an older word.
      if (written) copied();
      else unsay();
    },
  });
  // Leaving the page in control asks first: outside full screen Ctrl+W closes the tab, which in a terminal there
  // means "delete a word", and the agent would wait for control to come back.
  useEffect(() => {
    if (!inControl) return;
    const ask = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [inControl]);

  // A changed state may let it open again (a screen switched on, a computer back).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when what blocks it changes
  useEffect(() => setGaveUp(false), [blocked]);

  // A socket opens in the mode of the moment. When the mode changes, one whose stream changes mode in place (its
  // first frame said so) stays: the server switches it, and noVNC starts again on it (ADR 0058 §17). Any other opens
  // again in the new mode, and so does one the server didn't switch in time.
  useEffect(() => {
    const link = linkRef.current;
    if (link && !link.mode && openedIn.current !== mode) setRound((r) => r + 1);
  }, [mode]);
  useEffect(() => {
    if (!connect || !linkRef.current?.mode || screenMode === null || screenMode === mode) return;
    const late = setTimeout(() => setRound((r) => r + 1), SWITCH_WAIT_MS);
    return () => clearTimeout(late);
  }, [connect, mode, screenMode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `round` opens the screen again
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    if (!connect) {
      heldPicture(el)?.remove();
      setTaking(false);
      return;
    }
    // While it retries, the cover keeps saying why; a picture held over a hand back stays live, and over control
    // opening it stays under "Assumindo o controle…"; anything else is a fresh start.
    const holding = heldPicture(el) !== null;
    setTaking(holding && modeNow.current === "control");
    setView((v) => (holding || v === "offline" || v === "busy" || v === "paused" || v === "held" ? v : "connecting"));
    let cancelled = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let looking: ReturnType<typeof setInterval> | undefined;
    const goneStale = () =>
      setTimeout(() => {
        heldPicture(el)?.remove();
        setView("connecting");
      }, HOLD_MS);
    let stale = holding && modeNow.current !== "control" ? goneStale() : undefined;
    let link: DesktopLink | null = null;
    let rfb: RFB | null = null;
    let session: DesktopMode = modeNow.current;
    void import("@novnc/novnc").then(
      ({ default: Rfb }) => {
        if (cancelled) return;
        // The mode of the moment, which may have changed while noVNC loaded.
        const opening = modeNow.current;
        const socket = createSocket(
          desktopSocketUrl(window.location, { orgId: org.id, agentId, mode: opening, switches: true }),
        ) as unknown as WebSocket;
        const opened = new DesktopLink(socket);
        link = opened;
        linkRef.current = opened;
        openedIn.current = opening;
        // noVNC takes its channel's `on*` handlers: the close code comes through a listener of our own.
        socket.addEventListener("close", (e: CloseEvent) => {
          closed = true;
          clearInterval(looking);
          clearTimeout(stale);
          // A close that arrives after the next connection took over (watching turned control) leaves that one be.
          if (rfbRef.current === rfb) rfbRef.current = null;
          if (cancelled) return;
          setTaking(false);
          const next = desktopCloseState(e.code, e.reason);
          // Control ended (handed back): it opens again as a watcher over the picture it had; any other close says why.
          if (e.code !== DESKTOP_CLOSE.controlEnded || !holdPicture(el)) {
            heldPicture(el)?.remove();
            setView(next.state);
          }
          // What changed shows at once (someone took control); a state that blocks it stops the retry.
          void refetch();
          if (next.retry === "never") return setGaveUp(true);
          // "now" still waits a moment: the new state (control handed back) usually changes the mode first.
          const delay = next.retry === "now" ? 250 : desktopRetryMs(attempts.current);
          attempts.current++;
          timer = setTimeout(() => setRound((r) => r + 1), delay);
        });
        /** noVNC on the socket's next session, in `m`. */
        const start = (m: DesktopMode) => {
          const control = m === "control";
          session = m;
          setScreenMode(m);
          const next = new Rfb(el, opened.channel(), { shared: true });
          next.viewOnly = !control;
          // In control, a screen that draws no pointer of its own shows noVNC's dot, never none (watching, desktop.css).
          next.showDotCursor = control;
          next.qualityLevel = control ? 6 : 3;
          next.compressionLevel = 2;
          next.scaleViewport = true;
          next.resizeSession = false;
          // The person's keys go to the field over the screen (`useScreenKeys`), never to noVNC's canvas.
          next.focusOnClick = false;
          next.background = "transparent";
          next.addEventListener("connect", () => {
            attempts.current = 0;
            // Taking control puts the person's keys on the screen at once (a phone's keyboard waits for its button).
            if (control && !matchesNow(TOUCH)) keysRef.current?.focus({ preventScroll: true });
            // noVNC takes input now: a picture held over it loses its frost and lets clicks through (`HOLD_MS`).
            if (!cancelled) setTaking(false);
            const since = Date.now();
            const look = () => {
              const canvas = liveCanvas(el);
              if (canvas && !showsPicture(canvas) && Date.now() - since < PICTURE_WAIT_MS) return;
              clearInterval(looking);
              clearTimeout(stale);
              heldPicture(el)?.remove();
              if (cancelled) return;
              setView("live");
            };
            clearInterval(looking);
            looking = setInterval(look, PICTURE_POLL_MS);
            look();
          });
          next.addEventListener("clipboard", (e) => copiedThere((e as CustomEvent<{ text: string }>).detail.text));
          rfb = next;
          rfbRef.current = next;
        };
        // The server switched the stream (taken, handed back): noVNC starts again on this socket over the picture it
        // showed, as a new socket would in the new mode.
        opened.onSwitch = (m) => {
          clearInterval(looking);
          clearTimeout(stale);
          const held = holdPicture(el);
          if (rfbRef.current === rfb) rfbRef.current = null;
          rfb?.disconnect();
          setTaking(held && m === "control");
          stale = held && m !== "control" ? goneStale() : undefined;
          if (!held) setView("connecting");
          start(m);
          void refetch();
        };
        start(opening);
      },
      () => {
        if (cancelled) return;
        cancelled = true;
        setView("ended");
        setGaveUp(true);
      },
    );
    const end = () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(looking);
      clearTimeout(stale);
      if (rfbRef.current === rfb) rfbRef.current = null;
      if (linkRef.current === link) linkRef.current = null;
      if (closed) return;
      closed = true;
      // Handed back or taken: the picture stays over the connection that replaces this one.
      if ((session === "control") !== (modeNow.current === "control")) holdPicture(el);
      if (rfb) rfb.disconnect();
      else link?.socket.close();
    };
    // A browser that keeps the page for its Back button can keep its sockets open there for minutes: a viewer
    // nobody sees, holding the screen up and counted as watching. It goes with the page; coming back opens it again.
    const leave = (e: PageTransitionEvent) => {
      if (e.persisted) end();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      end();
    };
  }, [connect, round, org.id, agentId, createSocket, refetch, copiedThere]);
  useEffect(() => {
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) setRound((r) => r + 1);
    };
    window.addEventListener("pageshow", back);
    return () => window.removeEventListener("pageshow", back);
  }, []);
  useEffect(() => {
    if (inControl) return;
    setHandingBack(false);
    setGot(null);
    unsay();
    // Its field goes with control, and a field removed while focused may get no blur.
    setTyping(false);
  }, [inControl, unsay]);
  // In control, full screen starting or ending gives the keys back to the computer: a click on the full-screen
  // button leaves the browser's focus on it, where Space would toggle it and Esc would reach nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: full screen's changes move the keys too
  useEffect(() => {
    if (inControl && !touch && !handingBack) keysRef.current?.focus({ preventScroll: true });
  }, [head?.full, inControl, touch, handingBack]);

  const shown: DesktopViewState = blocked ?? view;
  const live = shown === "live";
  const settled = SETTLED.includes(shown);
  // A cover only a person's own step changes (`SETTLED`): the window's foot keeps no line under it.
  const final = settled && !live;
  useEffect(() => setPoll(settled ? 30_000 : 5_000), [settled]);
  const held = shown === "held";
  useEffect(() => onHeld?.(held), [held, onHeld]);
  const handoff = s?.handoff ?? null;
  const ask = inControl && handoff?.kind === "ask" ? handoff.instructions : null;
  // Until the screen's state says who (right after a 4409), someone.
  const controllerName =
    (s?.controllerUserId ? dir.memberById.get(s.controllerUserId)?.name : undefined) ?? t("channel.unknownPerson");

  // One new socket: no longer given up opens it; otherwise a new round does.
  const retry = () => {
    attempts.current = 0;
    setView("connecting");
    if (gaveUp) setGaveUp(false);
    else setRound((r) => r + 1);
    void refetch();
  };
  const takeover = () =>
    actions.takeover.mutate(
      { agentId, screen: "desktop" },
      {
        onError: (err) =>
          sayFailed(
            (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.live.actionFailed"),
          ),
      },
    );
  const finish = () => {
    if (!handoff) return;
    const words = backNote.trim();
    actions.done.mutate(words ? { handoffId: handoff.id, note: words } : handoff.id, {
      onSuccess: () => {
        setHandingBack(false);
        setBackNote("");
        onSettled?.();
      },
      onError: didntWork,
    });
  };
  const giveUp = () => {
    if (!handoff) return;
    actions.failed.mutate({ handoffId: handoff.id }, { onSuccess: () => onSettled?.(), onError: didntWork });
  };

  const handBackLabel = handoff?.kind === "ask" ? t("browser.inCard.done") : t("browser.inCard.handBack");
  const back = useHandBack(handoff?.kind !== "ask");
  // Over a cover the head says nothing the cover says (opening, the pause, why not): only who holds the screen.
  const sub = inControl
    ? ask
      ? t("desktop.sub.controlAsked", g)
      : t("desktop.sub.control", g)
    : shown === "hidden"
      ? t("desktop.sub.hidden", { person: controllerName })
      : live
        ? (head?.watching ?? t("agentComputer.sub.watching"))
        : "";
  const retrying = <span>{t("desktop.state.retrying")}</span>;
  const notice = <span className="muted">{t("desktop.control.notice", g)}</span>;
  // What programs there can see, kept to one line in the window (desktop.css). agentes.chat Cloud may screen the
  // session (ADR 0076): said behind an ⓘ after it.
  const controlLine = (
    <span className="dsk-words">
      {edition === "cloud" ? (
        <span className="ac-hintline">
          {notice}
          <InfoHint name={t("common.about", { label: t("desktop.session.check") })}>
            {t("desktop.session.screening")}
          </InfoHint>
        </span>
      ) : (
        notice
      )}
    </span>
  );
  const again = (
    <Button size="sm" icon="refresh" onClick={retry}>
      {t("desktop.retry")}
    </Button>
  );
  const cantShow = (
    <CantShowCover
      edition={edition}
      machine={machine}
      computer={computer}
      name={name}
      reason={shown === "outdated" ? "runner_outdated" : (s?.reason ?? null)}
      detail={s?.detail ?? null}
      color={color}
      onRetry={retry}
    />
  );
  const cover: Record<Exclude<DesktopViewState, "live">, ReactNode> = {
    connecting: <Cover color={color} sky spinner text={t("agentComputer.state.opening", g)} />,
    hidden: <Cover color={color} icon="eyeOff" text={t("browser.inCard.hiddenHelp", g)} />,
    offline: <Cover color={color} sky spinner text={t("agentComputer.state.opening", g)} help={retrying} />,
    busy: <Cover color={color} spinner text={t("desktop.state.busy")} help={retrying} />,
    noRoom: <Cover color={color} icon="alert" text={t("agentComputer.state.noRoom", { computer })} action={again} />,
    paused: (
      <Cover color={color} icon="pause" text={t("agentComputer.state.pausedPlain", { computer })} help={retrying} />
    ),
    held: (
      <Cover
        color={color}
        icon="pause"
        text={t("agentComputer.state.held", g)}
        help={t("agentComputer.state.heldHelp")}
      />
    ),
    forbidden: <Cover color={color} icon="lock" text={t("agentComputer.state.forbidden")} />,
    outdated: cantShow,
    unavailable: cantShow,
    ended:
      edition === "selfhost" ? (
        <Cover color={color} icon="dash" text={t("desktop.state.ended")} action={again} />
      ) : (
        cantShow
      ),
  };

  const watchActs = (
    <>
      {live && !s?.controllerUserId && canTakeOver && (s?.canControl || onTakeBrowser) && (
        <Button
          size="sm"
          icon="person"
          className="cmp-take"
          loading={actions.takeover.isPending}
          onClick={s?.canControl ? takeover : onTakeBrowser}
        >
          <span className="cmp-act-label">{t("desktop.takeover")}</span>
        </Button>
      )}
    </>
  );
  const controlActs = (
    <>
      {ask && (
        <Button
          size="sm"
          variant="ghost"
          icon="block"
          className="cmp-couldnt ac-btn--glyph"
          loading={actions.failed.isPending}
          onClick={giveUp}
        >
          <span className="cmp-act-label">{t("browser.inCard.couldnt")}</span>
        </Button>
      )}
      {!handingBack && (
        <Button
          size="sm"
          variant="primary"
          icon={back.icon}
          className={back.className}
          onClick={() => {
            // The note opens in the dialog, never over the full-screen screen.
            head?.setFull(false);
            setHandingBack(true);
          }}
        >
          <span className="cmp-act-label">{handBackLabel}</span>
        </Button>
      )}
    </>
  );

  return (
    <div className={cx("dsk", inControl && "is-control", final && "is-final")} data-state={shown}>
      <DialogHead
        sub={sub}
        actions={
          <>
            {inControl ? controlActs : watchActs}
            {(live || inControl || shown === "hidden") && !handingBack && <FullButton />}
          </>
        }
      />
      {ask && <p className="cmp-asked">“{ask}”</p>}
      <div
        className="brw-ac__stage dsk-stage"
        onPointerDownCapture={(e) => {
          // noVNC cancels its own mousedown, so the field keeps the focus a click on the screen gives it.
          if (inControl && e.pointerType !== "touch") keysRef.current?.focus({ preventScroll: true });
        }}
      >
        <div
          ref={screenRef}
          className={inControl ? "dsk-screen is-control" : "dsk-screen"}
          role="img"
          aria-label={t("agentComputer.screen", g)}
        />
        {inControl && (
          <textarea
            ref={keysRef}
            className="dsk-keys"
            aria-label={t("desktop.keyboard.field", g)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-gramm="false"
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
          />
        )}
        {shown !== "live"
          ? cover[shown]
          : (taking || (inControl && screenMode === "watch")) && (
              <Cover color={color} spinner text={t("desktop.taking")} />
            )}
      </div>
      {inControl &&
        (handingBack ? (
          // Pronto or Devolver: an optional word to the agent, which it reads as the person's own. One line that grows
          // as it wraps (`.brw-ac__note`), so all of a note stays in sight. Enter hands back as in the chat:
          // Shift+Enter, an input method's Enter and a phone's return key add a line instead.
          <div className="brw-ac__foot brw-ac__fail">
            <b>{handoff?.kind === "ask" ? t("browser.inCard.doneTitle", g) : t("browser.inCard.backTitle", g)}</b>
            <Textarea
              rows={1}
              autoGrow
              className="brw-ac__note"
              autoFocus
              value={backNote}
              onChange={(e) => setBackNote(e.target.value)}
              placeholder={t("browser.inCard.backPlaceholder", g)}
              aria-label={t("browser.inCard.backLabel", g)}
              maxLength={1000}
              onKeyDown={(e) => {
                if (e.key === "Escape") setHandingBack(false);
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || onScreenKeyboard()) return;
                e.preventDefault();
                finish();
              }}
            />
            <div className="brw-ac__row">
              <span className="brw-grow" />
              <Button size="sm" variant="ghost" onClick={() => setHandingBack(false)}>
                {t("browser.live.back")}
              </Button>
              <Button size="sm" variant="primary" icon="check" loading={actions.done.isPending} onClick={finish}>
                {handBackLabel}
              </Button>
            </div>
          </div>
        ) : (
          <div className="dsk-line">
            {touch && (
              <Button
                size="sm"
                icon="keyboard"
                aria-pressed={typing}
                // The field keeps its focus, so the phone's keyboard stays up.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => (typing ? keysRef.current?.blur() : keysRef.current?.focus({ preventScroll: true }))}
              >
                {t("desktop.keyboard.label")}
              </Button>
            )}
            {said ? (
              <span
                key={said.at}
                className={cx("dsk-said ac-iconline", said.error && "is-error")}
                role={said.error ? "alert" : "status"}
              >
                <Icon name={said.error ? "alert" : "check"} size={14} />
                <span>{said.text}</span>
              </span>
            ) : got === null ? (
              controlLine
            ) : (
              <span className="dsk-got" role="status">
                <span className="muted">{t("desktop.clipboard.got", g)}</span>
                <q>{quoteExcerpt(got, 120)}</q>
                <button
                  type="button"
                  className="ac-link"
                  // The keys stay on the screen's field.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void copyGot(got)}
                >
                  {t("desktop.clipboard.copy")}
                </button>
              </span>
            )}
          </div>
        ))}
      {/* Watching, under the screen and the covers it opens from by itself, so the window's foot is as deep as its
          sides and the screen opens in place. The ⓘ (what may be checked in control) comes with control;
          full screen keeps no line. */}
      {!inControl && !final && !head?.full && <ScreenNotice name={name} />}
    </div>
  );
}
