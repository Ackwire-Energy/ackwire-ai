import type { AppNotification } from "@agenteschat/client";
import { useChannels, useNotificationAction, useNotificationReply } from "@agenteschat/client";
import { type IslandItem, islandLead, noticeLine } from "@agenteschat/client/lib/island";
import { mediaWord } from "@agenteschat/client/lib/media";
import {
  opensConnectAi,
  opensOnComputer,
  openTarget,
  replyTarget,
  waitingCardOf,
} from "@agenteschat/client/lib/notifications";
import { Button, cx, Icon, Kbd, prefersReducedMotion } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { OpenDetailsContext } from "@/components/details-link";
import { useNotificationOpener } from "@/components/NotificationOpen";
import { type Dir, Face, Headline, SystemFace } from "@/components/NotificationParts";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { island } from "@/lib/island";
import "./notice-island.css";

/** How often the island counts its notices' time down. */
const TICK_MS = 250;
/** The pointer rests this long on the closed island before it opens (a pass over it doesn't). */
const OPEN_DELAY_MS = 140;
/** And leaves it this long before it closes. */
const CLOSE_DELAY_MS = 280;
/** "Enviado" stays this long before the notice leaves. */
const SENT_MS = 1400;
/** Notices the open island lists; the rest are in Atividade. */
const OPEN_MAX = 4;
/** The closing island folds back into itself. */
const LEAVE_MS = 340;

/**
 * The island (ADR 0071 §9): a dark pill at the top of the work area with what reached me while I'm here, the face
 * of whoever called. Resting the pointer on it (or a click, or the keyboard) opens it with the whole text and the
 * answer right there; a notice leaves after a few seconds, and one waiting on me shrinks and stays until I decide.
 */
export function NoticeIsland() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const channelName = useCallback(
    (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "",
    [channels.data],
  );
  const snap = useSyncExternalStore(island.subscribe, island.get, island.get);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The same island folds away when the last notice leaves.
  const [leaving, setLeaving] = useState<IslandItem[] | null>(null);
  const last = useRef<IslandItem[]>([]);
  useEffect(() => {
    if (snap.items.length) {
      last.current = snap.items;
      setLeaving(null);
      return;
    }
    setOpen(false);
    // It may leave under the pointer: no leave event comes then.
    island.pause("hover", false);
    if (!last.current.length) return;
    setLeaving(last.current);
    last.current = [];
    const timer = setTimeout(() => setLeaving(null), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [snap.items]);

  // Time runs while nobody looks: stopped open, typing, with the pointer on it or the tab hidden.
  useEffect(() => {
    const timer = setInterval(() => island.tick(TICK_MS), TICK_MS);
    const hidden = () => island.pause("hidden", document.visibilityState !== "visible");
    hidden();
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearInterval(timer);
      clearTimeout(hover.current);
      document.removeEventListener("visibilitychange", hidden);
      island.pause("hidden", false);
      island.pause("hover", false);
    };
  }, []);
  useEffect(() => island.pause("open", open), [open]);

  // A new notice on an island already showing: a short pulse, so it isn't missed.
  const seen = useRef(snap.seq);
  useEffect(() => {
    if (snap.seq === seen.current) return;
    seen.current = snap.seq;
    // Alone, it is the island arriving (its own entrance); open, the list shows it.
    if (snap.items.length < 2 || open || prefersReducedMotion()) return;
    root.current?.animate([{ transform: "scale(1)" }, { transform: "scale(1.045)" }, { transform: "scale(1)" }], {
      duration: 380,
      easing: "cubic-bezier(.3,1.4,.5,1)",
    });
  }, [snap.seq, open]);

  // Open: Esc or a click outside closes it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLElement>(".ni__pill")?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  const items = snap.items.length ? snap.items : leaving;
  if (!items?.length) return null;
  const { lead, small, others } = islandLead(items);
  if (!lead) return null;

  const enter = () => {
    clearTimeout(hover.current);
    island.pause("hover", true);
    if (!open) hover.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const exit = () => {
    clearTimeout(hover.current);
    island.pause("hover", false);
    hover.current = setTimeout(() => {
      // An answer being typed keeps it open.
      if (root.current?.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  };

  return (
    <div className="ni-wrap">
      {/* Resting the pointer on it opens it; the pill itself is the button (keyboard, a click). */}
      <div
        ref={root}
        className={cx("ni", open && "ni--open", !open && small && "ni--small", !snap.items.length && "ni--leaving")}
        data-theme="dark"
        onPointerEnter={enter}
        onPointerLeave={exit}
      >
        {open ? (
          <section aria-label={t("island.label")}>
            <ul className="ni__list">
              {items.slice(0, OPEN_MAX).map((item) => (
                <NoticeRow key={item.n.id} n={item.n} dir={dir} channelName={channelName} />
              ))}
            </ul>
            <div className="ni__foot">
              <Link to="/org/$orgId/notifications" params={{ orgId: org.id }} className="ni__all">
                {t("island.all")}
              </Link>
              <span className="ni__hint">
                <Kbd>Esc</Kbd>
                {t("island.closes")}
              </span>
            </div>
          </section>
        ) : (
          <button
            type="button"
            className="ni__pill"
            aria-expanded={false}
            aria-label={t("island.expand")}
            onClick={() => setOpen(true)}
            onKeyDown={(e) => {
              // Esc on the closed island puts it away: the waiting ones shrink, the rest leave.
              if (e.key === "Escape") island.putAway();
            }}
          >
            <Who n={lead.n} dir={dir} className="ni__face" />
            <span className="ni__head">
              <Headline n={lead.n} dir={dir} channelName={channelName} />
            </span>
            {!small && <Line n={lead.n} className="ni__line" />}
            {others > 0 && (
              <>
                <span className="ni__faces" aria-hidden="true">
                  {items
                    .filter((i) => i !== lead)
                    .slice(0, 2)
                    .map((i) => (
                      <Who key={i.n.id} n={i.n} dir={dir} className="ni__mini" />
                    ))}
                </span>
                <span className="ni__count">+{others}</span>
              </>
            )}
          </button>
        )}
      </div>
      {/* Read aloud as it arrives: who did what, and the line. */}
      <span className="ac-visually-hidden" role="status">
        {snap.items[0] && (
          <>
            <Headline n={snap.items[0].n} dir={dir} channelName={channelName} />: <Line n={snap.items[0].n} />
          </>
        )}
      </span>
    </div>
  );
}

/** Whoever called; nobody behind it (the workspace telling), what it is about, else a bell. */
function Who({ n, dir, className }: { n: AppNotification; dir: Dir; className?: string }) {
  if (n.actors[0]) return <Face actor={n.actors[0]} dir={dir} size="sm" className={className} />;
  // SystemFace is plain markup (no hooks): null for kinds it has no face for.
  return (
    SystemFace({ n, className: cx("ni__sys", className) }) ?? (
      <span className={cx("ni__sys", className)} aria-hidden="true">
        <Icon name="bell" size={16} />
      </span>
    )
  );
}

function Line({ n, className }: { n: AppNotification; className?: string }) {
  const { t } = useTranslation();
  const line = noticeLine(n, (kind) => mediaWord(t, kind));
  return line ? <span className={className}>{line}</span> : null;
}

/** One notice on the open island: who and what, the whole line, and the answer right there. */
function NoticeRow({
  n,
  dir,
  channelName,
}: {
  n: AppNotification;
  dir: Dir;
  channelName: (id: string) => string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const act = useNotificationAction(org.id);
  const reply = useNotificationReply(org.id);
  const openNotification = useNotificationOpener();
  const openDetails = useContext(OpenDetailsContext);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    island.pause(`typing:${n.id}`, typing);
    return () => island.pause(`typing:${n.id}`, false);
  }, [typing, n.id]);
  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing]);

  const target = replyTarget(n);
  const waiting = n.waiting ? waitingCardOf(n) : null;
  const suggestions = n.kind === "agent_question" ? (n.latest.suggestions ?? []) : [];
  const canOpen = Boolean(openTarget(n) || opensOnComputer(n) || opensConnectAi(n, undefined));

  const read = () => {
    if (!n.readAt) act.mutate({ type: "read", item: n, read: true });
  };
  const open = () => {
    read();
    island.settle(n.id);
    // An approval opens in its dialog over the page I'm on (approve or refuse there); the rest, where it happened.
    if (n.kind === "approval" && n.source.approvalId && openDetails) {
      openDetails({ kind: "approval", id: n.source.approvalId });
      return;
    }
    openNotification(n, org.id);
  };
  const answer = (text: string, choice = false) => {
    if (!target || !text.trim()) return;
    setFailed(false);
    reply.mutate(
      { target, text: text.trim(), choice },
      {
        onSuccess: () => {
          read();
          setTyping(false);
          setDone(choice ? t("island.answered", { choice: text.trim() }) : t("island.sent"));
          setTimeout(() => island.settle(n.id), SENT_MS);
        },
        onError: () => setFailed(true),
      },
    );
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    answer(draft);
  };

  return (
    <li className="ni__item">
      <Who n={n} dir={dir} className="ni__face" />
      <div className="ni__body">
        <p className="ni__title">
          <Headline n={n} dir={dir} channelName={channelName} />
        </p>
        <Line n={n} className="ni__text" />
        {done ? (
          <p className="ni__done" role="status">
            <Icon name="check" size={16} />
            {done}
          </p>
        ) : (
          <>
            {typing && target ? (
              <form className="ni__reply" onSubmit={submit}>
                <input
                  ref={input}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setTyping(false);
                    }
                  }}
                  placeholder={t("island.placeholder")}
                  aria-label={t("island.reply")}
                  disabled={reply.isPending}
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  icon="send"
                  iconOnly
                  aria-label={t("island.send")}
                  loading={reply.isPending}
                  disabled={!draft.trim()}
                />
              </form>
            ) : (
              <div className="ni__acts">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="ni__choice"
                    disabled={reply.isPending}
                    onClick={() => answer(s, true)}
                  >
                    {s}
                  </button>
                ))}
                {waiting && waiting.action !== "answer" && canOpen && (
                  <Button variant="primary" size="sm" onClick={open}>
                    {waiting.action === "review" ? t("island.review") : t("island.open")}
                  </Button>
                )}
                {target && (
                  <Button size="sm" icon="reply" onClick={() => setTyping(true)}>
                    {suggestions.length ? t("island.otherAnswer") : t("island.reply")}
                  </Button>
                )}
                {!(waiting && waiting.action !== "answer") && canOpen && (
                  <Button size="sm" onClick={open}>
                    {t("island.open")}
                  </Button>
                )}
              </div>
            )}
            {failed && <p className="ni__failed">{t("island.failed")}</p>}
          </>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        icon="close"
        iconOnly
        aria-label={t("island.dismiss")}
        className="ni__x"
        onClick={() => island.dismiss(n.id)}
      />
    </li>
  );
}
