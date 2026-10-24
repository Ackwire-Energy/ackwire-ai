import type { DesktopKeyboard, DesktopViewState } from "@agenteschat/client";
import {
  ApiError,
  DESKTOP_KEYBOARDS,
  desktopCloseState,
  desktopMode,
  desktopRetryMs,
  desktopSocketUrl,
  desktopStatusState,
  isDesktopKeyboard,
  keyboardFor,
  useBrowserHandoffMutations,
  useDesktopStatus,
  useStartDesktop,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Input, Select, SkyStrip } from "@agenteschat/ui";
import type RFB from "@novnc/novnc";
import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import { SocketFactoryContext } from "@/realtime/context";
import { Cover } from "../browser/BrowserCard";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import "../browser/browser.css";
import "./desktop.css";

/**
 * "Colar texto" presses Shift+Insert after setting the desktop's clipboard: it pastes in every window there,
 * a terminal too (where Ctrl+V doesn't; it reads PRIMARY, which Xvnc sets with the clipboard). Keysyms and
 * key codes are inline: the noVNC package exports only RFB.
 */
const SHIFT = { keysym: 0xffe1, code: "ShiftLeft" };
const INSERT = { keysym: 0xff63, code: "Insert" };

type KeyboardNavigator = Navigator & {
  keyboard?: { getLayoutMap(): Promise<{ get(code: string): string | undefined }> };
};

/** The layout to start with: the person's own choice, else a guess from the browser. */
async function startingKeyboard(): Promise<DesktopKeyboard> {
  const chosen = storage.get(STORAGE_KEYS.screenKeyboard);
  if (isDesktopKeyboard(chosen)) return chosen;
  let semicolon: string | undefined;
  try {
    semicolon = (await (navigator as KeyboardNavigator).keyboard?.getLayoutMap())?.get("Semicolon");
  } catch {
    // Not offered here (another browser, a frame): the language alone.
  }
  return keyboardFor(navigator.language, semicolon);
}

/**
 * An agent's desktop, live (ADR 0056): noVNC on a socket of its own. Watching is view-only at quality 3; in
 * control (the desktop's own handoff is this person's) it takes the pointer and keys at quality 6, with the
 * person's keyboard layout, "Colar texto", and what the desktop copies behind "Copiar" (never written to the
 * person's clipboard by itself). While someone else is in control the screen stays hidden; it opens again
 * by itself after drops, restarts and hand backs.
 */
export function DesktopView({
  agentId,
  name,
  onFold,
  onSettled,
}: {
  agentId: string;
  name: string;
  /** Folding takes the panel away. */
  onFold?: () => void;
  /** The person handed back or said it couldn't be done. */
  onSettled?: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const createSocket = useContext(SocketFactoryContext);
  const actions = useBrowserHandoffMutations(org.id);
  const start = useStartDesktop(org.id);
  const g = agentGrammar(t, name);
  const color = colorOf(dir.agentById.get(agentId));
  const [view, setView] = useState<DesktopViewState>("connecting");
  const [round, setRound] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const [keyboard, setKeyboard] = useState<DesktopKeyboard | null>(null);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [handingBack, setHandingBack] = useState(false);
  const [backNote, setBackNote] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [full, setFull] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const attempts = useRef(0);
  // Nothing says when a desktop starts or is handed back: asked often while it may show any moment.
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
  const inControl = mode === "control";
  const controlKeyboard = inControl ? keyboard : null;
  const connect = blocked === null && !gaveUp && keyboard !== null;
  const { refetch } = status;

  useEffect(() => {
    void startingKeyboard().then(setKeyboard);
  }, []);
  // A changed state may let it open again (a desktop switched on, a computer back).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when what blocks it changes
  useEffect(() => setGaveUp(false), [blocked]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `round` opens the screen again
  useEffect(() => {
    const el = screenRef.current;
    if (!connect || !el) return;
    // While it retries, the cover keeps saying why; anything else is a fresh start.
    setView((v) => (v === "offline" || v === "busy" || v === "paused" ? v : "connecting"));
    let cancelled = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | null = null;
    let rfb: RFB | null = null;
    void import("@novnc/novnc").then(
      ({ default: Rfb }) => {
        if (cancelled) return;
        // The socket opens only once noVNC can take it in the same tick: the computer speaks first, and bytes
        // that reach a socket before noVNC listens are lost, leaving both sides waiting until the computer gives up.
        const socket = createSocket(
          desktopSocketUrl(window.location, {
            orgId: org.id,
            agentId,
            mode,
            ...(controlKeyboard ? { keyboard: controlKeyboard } : {}),
          }),
        ) as unknown as WebSocket;
        ws = socket;
        socket.binaryType = "arraybuffer";
        // noVNC takes the socket's `on*` handlers: the close code comes through a listener of our own.
        socket.addEventListener("close", (e: CloseEvent) => {
          closed = true;
          // A close that arrives after the next connection took over (watching turned control) leaves that one be.
          if (rfbRef.current === rfb) rfbRef.current = null;
          if (cancelled) return;
          setCopied(null);
          const next = desktopCloseState(e.code, e.reason);
          setView(next.state);
          // What changed shows at once (someone took control, it was turned off); a state that blocks it stops the retry.
          void refetch();
          if (next.retry === "never") return setGaveUp(true);
          // "now" still waits a moment: the new state (control handed back) usually changes the mode first.
          const delay = next.retry === "now" ? 250 : desktopRetryMs(attempts.current);
          attempts.current++;
          timer = setTimeout(() => setRound((r) => r + 1), delay);
        });
        rfb = new Rfb(el, socket, { shared: true });
        rfb.viewOnly = !inControl;
        rfb.qualityLevel = inControl ? 6 : 3;
        rfb.compressionLevel = 2;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.focusOnClick = inControl;
        rfb.background = "transparent";
        rfb.addEventListener("connect", () => {
          attempts.current = 0;
          setView("live");
        });
        rfb.addEventListener("clipboard", (e) => setCopied((e as CustomEvent<{ text: string }>).detail.text));
        rfbRef.current = rfb;
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
      if (rfbRef.current === rfb) rfbRef.current = null;
      if (closed) return;
      closed = true;
      if (rfb) rfb.disconnect();
      else ws?.close();
    };
    // A browser that keeps the page for its Back button can keep its sockets open there for minutes: a viewer
    // nobody sees, holding the desktop up and counted as watching. It goes with the page; coming back opens it again.
    const leave = (e: PageTransitionEvent) => {
      if (e.persisted) end();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      end();
    };
  }, [connect, mode, controlKeyboard, round, org.id, agentId, createSocket, refetch, inControl]);
  useEffect(() => {
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) setRound((r) => r + 1);
    };
    window.addEventListener("pageshow", back);
    return () => window.removeEventListener("pageshow", back);
  }, []);

  // Full screen: the browser's own when it allows it; either way the panel fills the window.
  useEffect(() => {
    const el = root.current;
    if (!full || !el) return;
    const left = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", left);
    if (typeof el.requestFullscreen === "function") el.requestFullscreen().catch(() => {});
    return () => {
      document.removeEventListener("fullscreenchange", left);
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    };
  }, [full]);
  useEffect(() => {
    if (!inControl) setHandingBack(false);
  }, [inControl]);

  const shown: DesktopViewState = blocked ?? view;
  const live = shown === "live";
  // Live, or only a person's own step changes it: no need to ask often.
  const settledState =
    live || shown === "forbidden" || shown === "unavailable" || shown === "outdated" || shown === "ended";
  useEffect(() => setPoll(settledState ? 30_000 : 5_000), [settledState]);
  const handoff = s?.handoff ?? null;
  const ask = inControl && handoff?.kind === "ask" ? handoff.instructions : null;
  // Until the desktop's state says who (right after a 4409), someone.
  const controllerName =
    (s?.controllerUserId ? dir.memberById.get(s.controllerUserId)?.name : undefined) ?? t("channel.unknownPerson");
  const failedToast = () => toast.show(t("browser.live.actionFailed"), "error");

  const retry = () => {
    attempts.current = 0;
    setGaveUp(false);
    setView("connecting");
    void refetch().finally(() => setRound((r) => r + 1));
  };
  const takeover = () =>
    actions.takeover.mutate(
      { agentId, screen: "desktop" },
      {
        onError: (err) =>
          toast.show(
            (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.live.actionFailed"),
            "error",
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
      onError: failedToast,
    });
  };
  const giveUp = () => {
    if (!handoff) return;
    actions.failed.mutate({ handoffId: handoff.id }, { onSuccess: () => onSettled?.(), onError: failedToast });
  };
  const turnOn = () =>
    start.mutate(agentId, {
      onError: (err) =>
        toast.show(
          err instanceof ApiError && err.code === "machine.desktop_busy"
            ? t("desktop.startBusy")
            : t("desktop.startFailed"),
          "error",
        ),
    });
  const turnOff = () =>
    actions.stop.mutate(
      { agentId, screen: "desktop" },
      {
        onSuccess: () => {
          setConfirmStop(false);
          toast.show(t("desktop.stopped", g));
        },
        onError: failedToast,
      },
    );
  const paste = () => {
    const rfb = rfbRef.current;
    if (!rfb || !text) return;
    rfb.clipboardPasteFrom(text);
    rfb.sendKey(SHIFT.keysym, SHIFT.code, true);
    rfb.sendKey(INSERT.keysym, INSERT.code);
    rfb.sendKey(SHIFT.keysym, SHIFT.code, false);
    setText("");
    rfb.focus({ preventScroll: true });
  };
  const copy = (value: string) =>
    navigator.clipboard.writeText(value).then(
      () => toast.show(t("desktop.clipboard.copied")),
      () => toast.show(t("browser.live.actionFailed"), "error"),
    );
  const chooseKeyboard = (k: DesktopKeyboard) => {
    storage.set(STORAGE_KEYS.screenKeyboard, k);
    setKeyboard(k);
  };

  const handBackLabel = handoff?.kind === "ask" ? t("browser.inCard.done") : t("browser.inCard.handBack");
  const sub = inControl
    ? ask
      ? t("desktop.sub.controlAsked", g)
      : t("desktop.sub.control", g)
    : shown === "hidden"
      ? t("desktop.sub.hidden", { person: controllerName })
      : live
        ? t("desktop.sub.watching")
        : shown === "off"
          ? t("desktop.sub.off")
          : t("desktop.sub.connecting");
  const retrying = <span>{t("desktop.state.retrying")}</span>;
  const unavailableHelp =
    s?.reason === "not_allowed"
      ? t("browser.machine.offHelp")
      : s?.reason === "desktop_unavailable" && s.canStart
        ? s.detail
        : null;
  const cover: Record<Exclude<DesktopViewState, "live">, ReactNode> = {
    connecting: <Cover color={color} spinner text={t("desktop.state.connecting", g)} />,
    hidden: (
      <Cover
        color={color}
        icon="eyeOff"
        text={t("browser.live.otherInControl", { name: controllerName })}
        help={t("browser.inCard.hiddenHelp", g)}
      />
    ),
    off: (
      <Cover
        color={color}
        icon="power"
        text={t("desktop.state.off", g)}
        help={t("desktop.state.offHelp", g)}
        action={
          s?.canStart && (
            <Button size="sm" variant="primary" icon="power" loading={start.isPending} onClick={turnOn}>
              {t("desktop.start")}
            </Button>
          )
        }
      />
    ),
    offline: <Cover color={color} spinner text={t("browser.inCard.offline", g)} help={retrying} />,
    busy: <Cover color={color} spinner text={t("desktop.state.busy")} help={retrying} />,
    paused: <Cover color={color} icon="pause" text={t("desktop.state.paused", g)} help={retrying} />,
    forbidden: <Cover color={color} icon="lock" text={t("desktop.state.forbidden")} />,
    outdated: <Cover color={color} icon="alert" text={t("desktop.state.outdated", g)} />,
    unavailable: <Cover color={color} icon="dash" text={t("desktop.state.unavailable", g)} help={unavailableHelp} />,
    ended: (
      <Cover
        color={color}
        icon="power"
        text={t("desktop.state.ended")}
        action={
          <Button size="sm" icon="refresh" onClick={retry}>
            {t("desktop.retry")}
          </Button>
        }
      />
    ),
  };

  const watchActs = confirmStop ? (
    <>
      <span className="small muted">{t("desktop.stopAsk", g)}</span>
      <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
        {t("browser.watch.no")}
      </Button>
      <Button size="sm" variant="primary" loading={actions.stop.isPending} onClick={turnOff}>
        {t("desktop.stop")}
      </Button>
    </>
  ) : (
    <>
      {live && s?.canControl && !s.controllerUserId && (
        <Button size="sm" icon="person" loading={actions.takeover.isPending} onClick={takeover}>
          {t("desktop.takeover")}
        </Button>
      )}
      {s?.canStart && s.running && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="power"
          aria-label={t("desktop.stop")}
          title={t("desktop.stop")}
          onClick={() => setConfirmStop(true)}
        />
      )}
    </>
  );
  const controlActs = (
    <>
      {ask && (
        <Button size="sm" variant="ghost" loading={actions.failed.isPending} onClick={giveUp}>
          {t("browser.inCard.giveUp")}
        </Button>
      )}
      {!handingBack && (
        <Button size="sm" variant="primary" icon="check" onClick={() => setHandingBack(true)}>
          {handBackLabel}
        </Button>
      )}
    </>
  );
  const fullLabel = full ? t("browser.inCard.fullExit") : t("browser.inCard.full");

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group, not a fieldset
    <div
      ref={root}
      className={["brw-ac", "is-open", "dsk", inControl && "is-control", full && "is-full"].filter(Boolean).join(" ")}
      role="group"
      aria-label={t("desktop.title", g)}
      data-state={shown}
    >
      <SkyStrip color={color} muted={inControl} moving={live && !inControl} />
      <div className="brw-ac__head">
        <span className="brw-ac__tt is-static">
          <span className="brw-ac__tx">
            <b className={ask ? "is-ask" : undefined} title={ask ?? undefined}>
              {ask ?? t("desktop.title", g)}
            </b>
            <small>
              <span>{sub}</span>
            </small>
          </span>
        </span>
        <span className="brw-ac__acts">
          {inControl ? controlActs : watchActs}
          {live && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={full ? "close" : "external"}
              aria-label={fullLabel}
              title={fullLabel}
              onClick={() => setFull((v) => !v)}
            />
          )}
          {onFold && !full && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="chevronDown"
              className="brw-ac__chev"
              aria-label={t("browser.inCard.collapse")}
              title={t("browser.inCard.collapse")}
              onClick={onFold}
            />
          )}
        </span>
      </div>
      <div className="brw-ac__body">
        <div className="brw-ac__stage">
          <div
            ref={screenRef}
            className={inControl ? "dsk-screen is-control" : "dsk-screen"}
            role="img"
            aria-label={t("desktop.screen", g)}
          />
          {shown !== "live" && cover[shown]}
        </div>
      </div>
      {inControl &&
        (handingBack ? (
          // Pronto or Devolver: an optional word to the agent, which it reads as the person's own.
          <div className="brw-ac__foot brw-ac__fail">
            <b>{handoff?.kind === "ask" ? t("browser.inCard.doneTitle", g) : t("browser.inCard.backTitle", g)}</b>
            <Input
              autoFocus
              value={backNote}
              onChange={(e) => setBackNote(e.target.value)}
              placeholder={t("browser.inCard.backPlaceholder", g)}
              aria-label={t("browser.inCard.backLabel", g)}
              maxLength={1000}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  finish();
                } else if (e.key === "Escape") setHandingBack(false);
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
          <div className="brw-ac__foot dsk-foot">
            <label className="brw-tfield">
              <input
                placeholder={t("desktop.paste.placeholder")}
                aria-label={t("desktop.paste.label", g)}
                autoComplete="off"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    paste();
                  }
                }}
              />
              <Button
                variant="primary"
                size="sm"
                iconOnly
                icon="send"
                className="brw-tfield__send"
                aria-label={t("desktop.paste.send")}
                title={t("desktop.paste.send")}
                disabled={!text || !live}
                onClick={paste}
              />
            </label>
            {copied !== null && (
              <div className="dsk-copied">
                <span className="small">
                  {t("desktop.clipboard.got", g)} <q>{copied.length > 120 ? `${copied.slice(0, 120)}…` : copied}</q>
                </span>
                <Button size="sm" icon="copy" onClick={() => void copy(copied)}>
                  {t("desktop.clipboard.copy")}
                </Button>
              </div>
            )}
            <div className="brw-ac__row">
              <Select<DesktopKeyboard>
                size="sm"
                aria-label={t("desktop.keyboard.label")}
                value={keyboard ?? undefined}
                onValueChange={chooseKeyboard}
                options={DESKTOP_KEYBOARDS.map((k) => ({ value: k, label: t(`desktop.keyboard.layouts.${k}`) }))}
              />
              <span className="small muted dsk-notice">{t("desktop.control.notice")}</span>
            </div>
          </div>
        ))}
    </div>
  );
}
