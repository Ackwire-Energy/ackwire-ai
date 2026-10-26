import type { DesktopKeyboard, DesktopViewState, Edition, Machine } from "@agenteschat/client";
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
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Input, Select } from "@agenteschat/ui";
import type RFB from "@novnc/novnc";
import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { showsPicture } from "@/lib/canvas";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import { SocketFactoryContext } from "@/realtime/context";
import { Cover } from "../browser/BrowserCard";
import { CantShowCover } from "../computer/covers";
import { DialogHead, FullButton, useDialogHead } from "../computer/head";
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

/** Its state settles: live, or only a person's own step changes it. */
const SETTLED: DesktopViewState[] = ["live", "forbidden", "unavailable", "outdated", "ended", "noRoom"];

/**
 * "Live" waits for the screen's first picture: one that just started is black for a few seconds, until its desktop
 * draws. How often it's looked at, and how long at most before it's shown as it is (a screen black for good).
 */
const PICTURE_POLL_MS = 200;
const PICTURE_WAIT_MS = 10_000;

/**
 * An agent's screen, live (ADR 0058), as the computer dialog's stage: noVNC on a socket of its own, which
 * starts a screen that isn't running. Watching is view-only at quality 3; in control (the screen's own
 * handoff is this person's) it takes the pointer and keys at quality 6, with the person's keyboard layout,
 * "Colar texto", and what the screen copies behind "Copiar" (never written to the person's clipboard by
 * itself). While someone else is in control the screen stays hidden; it opens again by itself after drops,
 * restarts and hand backs. Its sub-line and actions go in the dialog's head.
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
  const toast = useToast();
  const head = useDialogHead();
  const createSocket = useContext(SocketFactoryContext);
  const actions = useBrowserHandoffMutations(org.id);
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
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
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
  const inControl = mode === "control";
  const controlKeyboard = inControl ? keyboard : null;
  const connect = blocked === null && !gaveUp && keyboard !== null;
  const { refetch } = status;

  useEffect(() => {
    void startingKeyboard().then(setKeyboard);
  }, []);
  // A changed state may let it open again (a screen switched on, a computer back).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when what blocks it changes
  useEffect(() => setGaveUp(false), [blocked]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `round` opens the screen again
  useEffect(() => {
    const el = screenRef.current;
    if (!connect || !el) return;
    // While it retries, the cover keeps saying why; anything else is a fresh start.
    setView((v) => (v === "offline" || v === "busy" || v === "paused" || v === "held" ? v : "connecting"));
    let cancelled = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let looking: ReturnType<typeof setInterval> | undefined;
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
          clearInterval(looking);
          // A close that arrives after the next connection took over (watching turned control) leaves that one be.
          if (rfbRef.current === rfb) rfbRef.current = null;
          if (cancelled) return;
          setCopied(null);
          const next = desktopCloseState(e.code, e.reason);
          setView(next.state);
          // What changed shows at once (someone took control); a state that blocks it stops the retry.
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
          // Taking control puts the person's keys on the screen at once.
          if (inControl) rfb?.focus({ preventScroll: true });
          const since = Date.now();
          const look = () => {
            const canvas = el.querySelector("canvas");
            if (canvas && !showsPicture(canvas) && Date.now() - since < PICTURE_WAIT_MS) return;
            clearInterval(looking);
            if (!cancelled) setView("live");
          };
          looking = setInterval(look, PICTURE_POLL_MS);
          look();
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
      clearInterval(looking);
      if (rfbRef.current === rfb) rfbRef.current = null;
      if (closed) return;
      closed = true;
      if (rfb) rfb.disconnect();
      else ws?.close();
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
  }, [connect, mode, controlKeyboard, round, org.id, agentId, createSocket, refetch, inControl]);
  useEffect(() => {
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) setRound((r) => r + 1);
    };
    window.addEventListener("pageshow", back);
    return () => window.removeEventListener("pageshow", back);
  }, []);
  useEffect(() => {
    if (!inControl) setHandingBack(false);
  }, [inControl]);

  const shown: DesktopViewState = blocked ?? view;
  const live = shown === "live";
  const settled = SETTLED.includes(shown);
  useEffect(() => setPoll(settled ? 30_000 : 5_000), [settled]);
  const held = shown === "held";
  useEffect(() => onHeld?.(held), [held, onHeld]);
  const handoff = s?.handoff ?? null;
  const ask = inControl && handoff?.kind === "ask" ? handoff.instructions : null;
  // Until the screen's state says who (right after a 4409), someone.
  const controllerName =
    (s?.controllerUserId ? dir.memberById.get(s.controllerUserId)?.name : undefined) ?? t("channel.unknownPerson");
  const failedToast = () => toast.show(t("browser.live.actionFailed"), "error");

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
  const failed = shown === "unavailable" || shown === "outdated" || shown === "ended" || shown === "noRoom";
  const sub = inControl
    ? ask
      ? t("desktop.sub.controlAsked", g)
      : t("desktop.sub.control", g)
    : shown === "hidden"
      ? t("desktop.sub.hidden", { person: controllerName })
      : held
        ? t("agentComputer.sub.held")
        : live
          ? (head?.watching ?? t("agentComputer.sub.watching"))
          : failed || shown === "forbidden"
            ? ""
            : t("agentComputer.sub.opening");
  const retrying = <span>{t("desktop.state.retrying")}</span>;
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
    hidden: (
      <Cover
        color={color}
        icon="eyeOff"
        text={t("browser.live.otherInControl", { name: controllerName })}
        help={t("browser.inCard.hiddenHelp", g)}
      />
    ),
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
          loading={actions.takeover.isPending}
          onClick={s?.canControl ? takeover : onTakeBrowser}
        >
          {t("desktop.takeover")}
        </Button>
      )}
    </>
  );
  const controlActs = (
    <>
      {ask && (
        <Button size="sm" variant="ghost" loading={actions.failed.isPending} onClick={giveUp}>
          {t("browser.inCard.couldnt")}
        </Button>
      )}
      {!handingBack && (
        <Button size="sm" variant="primary" icon="check" onClick={() => setHandingBack(true)}>
          {handBackLabel}
        </Button>
      )}
    </>
  );

  return (
    <div className={["dsk", inControl && "is-control"].filter(Boolean).join(" ")} data-state={shown}>
      <DialogHead
        sub={sub}
        actions={
          <>
            {inControl ? controlActs : watchActs}
            {(live || inControl || shown === "hidden") && <FullButton />}
          </>
        }
      />
      {ask && <p className="cmp-asked">“{ask}”</p>}
      <div className="brw-ac__stage dsk-stage">
        <div
          ref={screenRef}
          className={inControl ? "dsk-screen is-control" : "dsk-screen"}
          role="img"
          aria-label={t("agentComputer.screen", g)}
        />
        {shown !== "live" && cover[shown]}
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
              <span className="small muted dsk-notice">{t("desktop.control.notice", g)}</span>
            </div>
          </div>
        ))}
    </div>
  );
}
