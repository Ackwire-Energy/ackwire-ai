import type { BrowserHandoff, BrowserInputEvent } from "@agenteschat/client";
import {
  clickEvents,
  framePoint,
  isOpenHandoff,
  keyboardEvents,
  keyEvents,
  modifiersOf,
  textEvent,
  useAgentBrowserHandoff,
  useBrowserHandoff,
  useBrowserHandoffMutations,
  useMachines,
  wheelEvent,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, FilterToggle, Icon, PixelSpinner, Textarea } from "@agenteschat/ui";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useBrowserLive } from "@/realtime/context";
import { AgentAvatar } from "../AgentAvatar";
import { useOrg } from "../org-context";
import "./browser.css";

const FAIL_REASONS = ["code", "password", "blocked"] as const;
const KEYS = ["Tab", "Enter", "Backspace", "Escape"] as const;

const RANK: Record<BrowserHandoff["status"], number> = {
  pending: 0,
  active: 1,
  done: 2,
  failed: 2,
  expired: 2,
  cancelled: 2,
};

/** Two views of the open request (the socket's, the cache's): the one further along wins; another request, the first. */
function newest(a: BrowserHandoff | null, b: BrowserHandoff | null): BrowserHandoff | null {
  if (!a || !b) return a ?? b;
  if (a.id !== b.id) return a;
  return RANK[b.status] > RANK[a.status] ? b : a;
}

/** "https://dashboard.stripe.com/login?x=1" → "dashboard.stripe.com/login". */
function shortUrl(url: string | undefined) {
  if (!url) return "";
  const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  return m ? `${m[1]}${(m[2] ?? "").replace(/\/$/, "")}` : url;
}

/**
 * The live view of an agent's browser (ADR 0040 §6–7, telas/NavegadorAgente.html
 * "Tela ao vivo"): the page as it is now, the agent's request on top; the
 * person in control clicks on the page, types in the app's own field (hidden
 * for passwords, so the password manager fills it) and presses Pronto or
 * Não consegui. Others watch.
 */
export function BrowserLiveView({
  agentId,
  handoffId,
  watch,
}: {
  agentId: string;
  handoffId?: string;
  watch?: boolean;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(t, name);
  const live = useBrowserLive(agentId);
  const open = useAgentBrowserHandoff(org.id, agentId);
  const asked = useBrowserHandoff(org.id, handoffId);
  const actions = useBrowserHandoffMutations(org.id);
  const machines = useMachines(org.id);
  // The newest view of the request: the socket's status, else the open one, else the one in the link.
  const handoff = newest(
    live.status?.handoff ?? null,
    newest(open.data ?? null, asked.data && isOpenHandoff(asked.data) ? asked.data : null),
  );
  const ended: BrowserHandoff | null = asked.data && !isOpenHandoff(asked.data) ? asked.data : null;
  const controller = handoff?.status === "active" ? handoff.controllerUserId : null;
  const inControl = controller === me.user.id && handoff?.status === "active";
  const otherInControl = Boolean(controller) && controller !== me.user.id;
  const machineId = handoff?.machineId ?? null;
  const remoteIsMac = (machines.data ?? []).find((m) => m.id === machineId)?.os === "darwin";

  const [secure, setSecure] = useState(false);
  const [text, setText] = useState("");
  const [mark, setMark] = useState<{ x: number; y: number; key: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [reason, setReason] = useState<(typeof FAIL_REASONS)[number] | null>(null);
  const [note, setNote] = useState("");
  const [finished, setFinished] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const claimed = useRef(false);

  // Opened from a notification or a link: take the request if nobody has it yet.
  useEffect(() => {
    if (watch || claimed.current || !handoff || handoff.status !== "pending") return;
    claimed.current = true;
    actions.takeControl.mutate(handoff.id, {
      onError: (err) =>
        toast.show(
          (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
          "error",
        ),
    });
  }, [watch, handoff, actions.takeControl, toast, t]);

  const title = t("browser.live.docTitle", g);
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);

  const close = () => {
    if (router.history.length > 1) router.history.back();
    else void navigate({ to: "/org/$orgId", params: { orgId: org.id } });
  };

  const send = (events: BrowserInputEvent[] | null) => {
    if (!inControl || !events?.length) return;
    live.sendInput(events);
  };

  const onPageClick = (e: MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    const meta = live.frame?.metadata;
    if (!inControl || !img || !meta) return;
    const rect = img.getBoundingClientRect();
    const at = framePoint(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      { width: rect.width, height: rect.height },
      meta,
    );
    if (!at) return;
    setMark({ x: e.clientX - rect.left, y: e.clientY - rect.top, key: Date.now() });
    send(clickEvents(at, modifiersOf(e, remoteIsMac)));
  };

  const onPageWheel = (e: WheelEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    const meta = live.frame?.metadata;
    if (!inControl || !img || !meta) return;
    const rect = img.getBoundingClientRect();
    const at = framePoint(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      { width: rect.width, height: rect.height },
      meta,
    );
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

  const finish = () => {
    if (!handoff) return;
    actions.done.mutate(handoff.id, {
      onSuccess: () => setFinished(true),
      onError: () => toast.show(t("browser.live.actionFailed"), "error"),
    });
  };

  const fail = () => {
    if (!handoff) return;
    const words = [reason ? t(`browser.live.failReasons.${reason}`) : "", note.trim()].filter(Boolean).join(". ");
    actions.failed.mutate(
      { handoffId: handoff.id, ...(words ? { note: words } : {}) },
      {
        onSuccess: () => {
          setSheet(false);
          close();
        },
        onError: () => toast.show(t("browser.live.actionFailed"), "error"),
      },
    );
  };

  const takeover = () =>
    actions.takeover.mutate(agentId, {
      onError: (err) =>
        toast.show(
          (err as { status?: number }).status === 409 ? t("browser.live.notInControl") : t("browser.live.actionFailed"),
          "error",
        ),
    });

  const unavailable = live.unavailable;
  const reconnecting = unavailable?.reason === "reconnecting";
  const blocker = live.ended
    ? t("browser.live.ended", g)
    : unavailable && !reconnecting
      ? unavailable.reason === "offline"
        ? t("browser.live.offline", g)
        : unavailable.reason === "no_computer"
          ? t("browser.live.noComputer", g)
          : unavailable.reason === "forbidden"
            ? t("browser.live.forbidden")
            : (unavailable.message ?? t("browser.live.unavailable"))
      : live.error === "forbidden" || live.error === "not_found"
        ? t("browser.live.forbidden")
        : null;
  const controllerName = controller ? (dir.memberById.get(controller)?.name ?? t("channel.unknownPerson")) : "";
  const ask = handoff?.kind === "ask" ? handoff.instructions : (ended?.instructions ?? null);
  const frame = live.frame;
  const src = frame ? `data:image/jpeg;base64,${frame.data}` : null;
  const showDone = finished || (ended !== null && ended.status === "done" && !handoff);

  return (
    <div className="brw-live" role="dialog" aria-modal="true" aria-label={t("browser.live.docTitle", g)}>
      <div className="brw-lbar">
        <AgentAvatar
          agentId={agentId}
          size="md"
          name={name}
          state={inControl ? "waiting" : otherInControl ? "idle" : "thinking"}
        />
        <div className="brw-lbar__ask">
          <small>{ask ? t("browser.live.asked", { name }) : t("browser.live.watching", g)}</small>
          <b>{ask ?? shortUrl(frame?.metadata.url)}</b>
        </div>
        {inControl ? (
          <span className="brw-badge">
            <span className="brw-badge__pulse" />
            {t("browser.live.inControl")}
          </span>
        ) : otherInControl ? (
          <span className="brw-badge brw-badge--watch">
            <span className="brw-badge__pulse" />
            {t("browser.live.otherInControl", { name: controllerName })}
          </span>
        ) : (
          <span className="brw-badge brw-badge--watch">
            <span className="brw-badge__pulse" />
            {t("browser.live.watchOnly")}
          </span>
        )}
        {reconnecting && inControl && <span className="brw-left">{t("browser.live.graceHint", g)}</span>}
        <div className="brw-lbar__acts">
          {inControl ? (
            <>
              {handoff?.kind === "ask" && (
                <Button variant="ghost" onClick={() => setSheet(true)} disabled={actions.failed.isPending}>
                  {t("browser.live.couldnt")}
                </Button>
              )}
              <Button variant="primary" icon="check" loading={actions.done.isPending} onClick={finish}>
                {handoff?.kind === "ask" ? t("browser.live.done") : t("browser.live.handBack")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                {t("browser.live.close")}
              </Button>
              {!otherInControl && !blocker && (
                <Button icon="person" loading={actions.takeover.isPending} onClick={takeover}>
                  {t("browser.live.takeover")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="brw-stage">
        <div className="brw-frame">
          <div className="brw-url">
            <Icon name="lock" size={14} />
            <span className="brw-url__pill">{shortUrl(frame?.metadata.url) || "…"}</span>
          </div>
          {src ? (
            // biome-ignore lint/a11y/noStaticElementInteractions: the page takes the person's keys while in control
            <div
              className={inControl ? "brw-view brw-view--control" : "brw-view"}
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
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys go through the frame's own handler above */}
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
            <div className="brw-view brw-view--blank">
              {!blocker && (
                <span className="brw-dim__box">
                  <PixelSpinner size={16} />
                  {t("browser.live.starting")}
                </span>
              )}
            </div>
          )}
          {(reconnecting || blocker) && (
            <div className="brw-dim">
              <span className="brw-dim__box" role="status">
                {reconnecting && <PixelSpinner size={16} />}
                {reconnecting ? t("browser.live.reconnecting") : blocker}
              </span>
            </div>
          )}
        </div>
      </div>

      {inControl || !otherInControl ? (
        <div className={inControl ? "brw-lfoot" : "brw-lfoot brw-lfoot--off"}>
          <label className="brw-typer">
            <input
              type={secure ? "password" : "text"}
              placeholder={t("browser.live.typeHere")}
              aria-label={t("browser.live.typeLabel")}
              autoComplete={secure ? "current-password" : "off"}
              value={text}
              disabled={!inControl}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendText();
                }
              }}
            />
            <span className="brw-typer__to">{t("browser.live.typeToPage")}</span>
            <Button size="sm" icon="send" disabled={!inControl || !text} onClick={sendText}>
              {t("browser.live.send")}
            </Button>
          </label>
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
          <div className="brw-keys">
            {KEYS.map((key) => (
              <button key={key} type="button" className="brw-key" onClick={() => send(keyEvents(key))}>
                {t(`browser.live.keys.${key}`)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="brw-lfoot">
          <span className="small muted">{t("browser.live.otherInControlHelp", { name: controllerName })}</span>
        </div>
      )}

      {sheet && (
        <div className="brw-sheet">
          <div className="brw-sheet__panel" role="dialog" aria-modal="true" aria-labelledby="brw-fail-title">
            <h2 id="brw-fail-title">{t("browser.live.failTitle")}</h2>
            <p>{t("browser.live.failHelp", g)}</p>
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
              rows={3}
              maxLength={900}
            />
            <div className="brw-sheet__row">
              <Button variant="ghost" onClick={() => setSheet(false)}>
                {t("browser.live.back")}
              </Button>
              <Button variant="primary" loading={actions.failed.isPending} onClick={fail}>
                {t("browser.live.failSend", g)}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showDone && (
        <div className="brw-donebox">
          <div className="brw-donebox__panel" role="status">
            <AgentAvatar agentId={agentId} size="lg" name={name} state="idle" />
            <h2>{t("browser.live.doneTitle")}</h2>
            <p>{t("browser.live.doneText", g)}</p>
            <Button onClick={close}>{t("browser.live.backToChat")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
