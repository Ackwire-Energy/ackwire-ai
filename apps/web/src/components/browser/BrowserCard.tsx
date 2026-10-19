import type { BrowserHandoff, BrowserInputEvent, BrowserStep, LiveRun } from "@agenteschat/client";
import {
  browserSiteUrl,
  browserSteps,
  clickEvents,
  frameMetadata,
  isOpenHandoff,
  keyboardEvents,
  keyEvents,
  modifiersOf,
  pagePoint,
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
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useBrowserLive } from "@/realtime/context";
import { AgentAvatar } from "../AgentAvatar";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { useBrowserCardRequest } from "./open";
import "./browser.css";

const FAIL_REASONS = ["code", "password", "blocked"] as const;
const KEYS = ["Tab", "Enter", "Backspace", "Escape"] as const;

const STEP_ICON = {
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
const iconOf = (tool: string): IconName => (isStepTool(tool) ? STEP_ICON[tool] : "globe");

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

/** The browser card on an agent's live row, while (and after) it used its browser in this run. */
export function RunBrowserCard({ run, name }: { run: LiveRun; name: string }) {
  const steps = browserSteps(run.work);
  if (steps.length === 0) return null;
  return <BrowserCard agentId={run.agentId} name={name} steps={steps} />;
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
}: {
  agentId: string;
  name: string;
  /** What the agent did in its browser in this run (the log); none outside a run. */
  steps?: BrowserStep[];
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
  const [open, setOpen] = useState(defaultOpen);
  const live = useBrowserLive(agentId, open);
  const openQ = useAgentBrowserHandoff(org.id, agentId, open);
  const actions = useBrowserHandoffMutations(org.id);
  const machines = useMachines(org.id);
  const root = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const handoff = newest(
    live.status?.handoff ?? null,
    newest(openQ.data ?? null, given && isOpenHandoff(given) ? given : null),
  );
  const controller = handoff?.status === "active" ? handoff.controllerUserId : null;
  const inControl = controller === me.user.id;
  const otherInControl = Boolean(controller) && !inControl;
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

  // The bar or a notification asked for this card: open it here and bring it into view.
  const asked = useBrowserCardRequest({ agentId, ...(given ? { handoffId: given.id } : {}) });
  useEffect(() => {
    if (asked === null) return;
    setOpen(true);
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
    setMark({ x: e.clientX - box.left, y: e.clientY - box.top, key: Date.now() });
    send(clickEvents(at, modifiersOf(e, remoteIsMac)));
  };

  const onPageWheel = (e: WheelEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    const meta = live.frame ? frameMetadata(live.frame) : undefined;
    if (!inControl || !img || !meta) return;
    const at = pagePoint({ x: e.clientX, y: e.clientY }, img.getBoundingClientRect(), meta);
    if (at) send([wheelEvent(at, e.deltaX, e.deltaY)]);
  };

  const onPageKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!inControl) return;
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
    actions.takeover.mutate(agentId, {
      onError: (err) =>
        toast.show(
          (err as { status?: number }).status === 409 ? t("browser.live.notInControl") : t("browser.live.actionFailed"),
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

  if (stoppedAt) {
    return (
      <div className="brw-ac" ref={root}>
        <div className="brw-ac__head">
          <span className="brw-stile brw-stile--lg" aria-hidden="true">
            <Icon name="stop" size={14} />
          </span>
          <span className="brw-ac__tx">
            <b>{t("browser.watch.stopped")}</b>
            <small>
              <span>{t("browser.watch.stoppedBy", { time: formatTime(i18n.language, stoppedAt) })}</span>
            </small>
          </span>
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
  const [host, path] = hostAndPath(browserSiteUrl(frame?.metadata.url, steps));
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
  const chevron = (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      icon="chevronDown"
      className="brw-ac__chev"
      aria-label={toggleLabel}
      title={toggleLabel}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
    />
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
      <div className="brw-ac__head">
        <button type="button" className="brw-ac__tt" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {host ? (
            <span className="brw-stile brw-stile--lg" aria-hidden="true">
              {host.charAt(0)}
            </span>
          ) : (
            <AgentAvatar agentId={agentId} name={name} size="sm" className="brw-ac__avatar" aria-hidden="true" />
          )}
          <span className="brw-ac__tx">
            <b className={asTitle === "ask" ? "is-ask" : undefined} title={asTitle === "ask" ? title : undefined}>
              {title}
              {asTitle === "host" && path && <span className="brw-ac__path">{path}</span>}
            </b>
            <small>
              {(live_ || reconnecting) && <PixelSpinner size={14} color={color} />}
              <span>{sub}</span>
            </small>
          </span>
        </button>
        <span className="brw-ac__acts">
          {inControl ? (
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
                {ask ? t("browser.inCard.done") : t("browser.inCard.handBack")}
              </Button>
              {!open && chevron}
            </>
          ) : confirmStop ? (
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
            <>
              {open && !otherInControl && !blocker && (
                <>
                  <Button
                    size="sm"
                    iconOnly
                    icon="person"
                    aria-label={t("browser.inCard.takeover")}
                    title={t("browser.inCard.takeover")}
                    loading={actions.takeover.isPending}
                    onClick={takeover}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="stop"
                    className="brw-ac__stop"
                    aria-label={t("browser.inCard.stop")}
                    title={t("browser.inCard.stop")}
                    onClick={() => setConfirmStop(true)}
                  />
                </>
              )}
              {chevron}
            </>
          )}
        </span>
      </div>

      {open && (
        <>
          <div className={showLog ? "brw-ac__body brw-ac__body--split" : "brw-ac__body"}>
            <div className="brw-ac__stage">
              {src ? (
                // biome-ignore lint/a11y/noStaticElementInteractions: the page takes the person's keys while in control
                <div
                  className={inControl ? "brw-ac__page is-control" : "brw-ac__page"}
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
                  <img
                    ref={imgRef}
                    src={src}
                    alt={t("browser.live.page", g)}
                    draggable={false}
                    onClick={onPageClick}
                    onWheel={onPageWheel}
                  />
                  {mark && <span key={mark.key} className="brw-mark" style={{ left: mark.x, top: mark.y }} />}
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
              <div className="brw-ac__foot">
                <div className="brw-ac__row">
                  <label className="brw-typer">
                    <input
                      type={secure ? "password" : "text"}
                      placeholder={t("browser.live.typeHere")}
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
                    <span className={mark ? "brw-typer__to is-marked" : "brw-typer__to"}>
                      {mark ? t("browser.live.typeToPage") : t("browser.live.typeClickFirst")}
                    </span>
                    <button
                      type="button"
                      className="brw-secure"
                      aria-pressed={secure}
                      aria-label={t("browser.live.secureLabel")}
                      onClick={() => setSecure((v) => !v)}
                    >
                      <Icon name="lock" size={14} />
                      {t("browser.live.secure")}
                    </button>
                    <Button size="sm" icon="send" disabled={!text} onClick={sendText}>
                      {t("browser.live.send")}
                    </Button>
                  </label>
                </div>
                <div className="brw-ac__row">
                  <div className="brw-keys">
                    {KEYS.map((key) => (
                      <button key={key} type="button" className="brw-key" onClick={() => send(keyEvents(key))}>
                        {t(`browser.live.keys.${key}`)}
                      </button>
                    ))}
                  </div>
                  <span className="brw-grow" />
                  {ask && (
                    <Button size="sm" variant="ghost" onClick={() => setFailing(true)}>
                      {t("browser.inCard.couldnt")}
                    </Button>
                  )}
                </div>
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
