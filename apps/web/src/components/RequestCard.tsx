import type { Agent } from "@agenteschat/client";
import { ExpiryFuse } from "@agenteschat/ui";
import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CardSky, colorOf } from "./Sky";
import "./request-card.css";

/**
 * What an agent can ask of a person in the conversation: each says so in the card's header and in the bar.
 * "proposal": a change to the workspace's context or an agent's instructions; "agent": a new agent.
 */
export type RequestKind = "approval" | "secret" | "question" | "browser" | "desktop" | "proposal" | "agent";

/** A request waiting for the viewer, as its card registers it: the bar above the composer says it. */
export type PendingAsk = { id: string; kind: RequestKind; agentId: string; what: string };

/** The same request, said the same way: nothing for the bar to redraw. */
export const sameAsk = (a: PendingAsk | undefined, b: PendingAsk | undefined) =>
  a?.id === b?.id && a?.kind === b?.kind && a?.agentId === b?.agentId && a?.what === b?.what;

/**
 * The request cards waiting for the viewer in one conversation's scroller, by their root element. A card puts
 * itself here while it waits for the viewer and takes itself out after; the bar above the composer watches them
 * (`useAsksOutOfView`), so nothing has to scan the rows while an agent writes.
 */
export function createAskRegistry() {
  const cards = new Map<HTMLElement, PendingAsk>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    cards: cards as ReadonlyMap<HTMLElement, PendingAsk>,
    put(el: HTMLElement, ask: PendingAsk) {
      if (sameAsk(cards.get(el), ask)) return;
      cards.set(el, ask);
      changed();
    },
    drop(el: HTMLElement) {
      if (cards.delete(el)) changed();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type AskRegistry = ReturnType<typeof createAskRegistry>;

const AskRegistryContext = createContext<AskRegistry | null>(null);

/**
 * Around one conversation's scroller, and only it: a card anywhere else (a panel beside it, a dialog) would
 * never read as in view there. Without one, a card registers nothing.
 */
export const AskRegistryProvider = AskRegistryContext.Provider;

/** setTimeout's longest wait (about 24.8 days): a later deadline is waited for in steps. */
const LONGEST_WAIT = 2_147_483_647;

/**
 * Whether `expiresAt` has passed, drawn again the moment it does (one timer for that moment, no clock), so a
 * request stops waiting on time even when no event says it expired. None: no deadline.
 */
export function useExpired(expiresAt: string | null | undefined) {
  const end = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const passed = Date.now() >= end;
  const [, redraw] = useState(0);
  useEffect(() => {
    if (Number.isNaN(end) || passed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = () => {
      const ms = end - Date.now();
      // A timer may fire a little early: it waits out the rest.
      if (ms > 0) timer = setTimeout(wait, Math.min(ms, LONGEST_WAIT));
      else redraw((n) => n + 1);
    };
    wait();
    return () => clearTimeout(timer);
  }, [end, passed]);
  return passed;
}

/**
 * One card for every request an agent makes in the conversation, so each reads the same way and its decision
 * sits in the same place: a quiet header (what kind of request, and whether it waits for you), the agent's own
 * words, the object in a well of two lines with "Ver …" opening it whole, anything to fill in, and the footer
 * strip with the decision on the left and the time left on the right.
 *
 * While it waits for the viewer it registers with its conversation (`AskRegistryProvider`), so the bar above the
 * composer can say it waits while it is out of view; `data-ask-id` lets "Ver" find it and bring it back.
 */
export function RequestCard({
  id,
  kind,
  agent,
  label,
  mine,
  waitingFor,
  lead,
  object,
  details,
  open: openProp,
  onOpenChange,
  body,
  actions,
  end,
  what,
  onSubmit,
  muted = false,
}: {
  id: string;
  kind: RequestKind;
  agent: Agent | undefined;
  /** The group's accessible name. */
  label: string;
  /** The viewer can answer it: the header says it waits for you (and the bar may bring it back). */
  mine: boolean;
  /** Who it waits for when it isn't the viewer. */
  waitingFor?: string;
  /** The agent's own words: what it asks. */
  lead: ReactNode;
  /** The thing it is about, in two lines with a logo; `more` labels the button that opens `details`. */
  object?: { logo: ReactNode; title: ReactNode; detail?: ReactNode; more?: string };
  /** What "Ver …" opens: the whole action (an email as the email), the change, where it came from. */
  details?: ReactNode;
  /** Controlled "Ver …" (otherwise the card keeps it); with no `details`, what it opens lives outside the card. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Anything to fill in before deciding (a secret's field), above the footer. */
  body?: ReactNode;
  /** The footer's decision, primary first. Without it (and without `end`) the card has no footer. */
  actions?: ReactNode;
  /** The footer's right end: the fuse and its time left. */
  end?: ReactNode;
  /** The object's short title, for the bar ("Enviar e-mail"). */
  what: string;
  /** Its field and footer are a form (a secret): Enter sends it. */
  onSubmit?: () => void;
  /** Overtaken (a newer card took its place): drawn quiet, nothing to do. */
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const registry = useContext(AskRegistryContext);
  const root = useRef<HTMLDivElement>(null);
  const agentId = agent?.id ?? "";
  // Waiting for the viewer: in the conversation's list, with what the bar says (kept current in place).
  useEffect(() => {
    const el = root.current;
    if (registry && mine && el) registry.put(el, { id, kind, agentId, what });
  }, [registry, mine, id, kind, agentId, what]);
  useEffect(() => {
    const el = root.current;
    if (!registry || !mine || !el) return;
    return () => registry.drop(el);
  }, [registry, mine]);
  const [openSelf, setOpenSelf] = useState(false);
  const open = openProp ?? openSelf;
  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setOpenSelf(next);
    onOpenChange?.(next);
  };
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const foot = (actions || end) && (
    <div className="rq__foot">
      {actions}
      {end && <span className="rq__end">{end}</span>}
    </div>
  );
  const inner = (
    <>
      <CardSky color={colorOf(agent)} />
      <div className="rq__head">
        <span className="rq__kind">{tt(`ask.kind.${kind}`)}</span>
        {mine ? (
          <span className="rq__state">
            <WaitMark />
            {t("ask.waitingYou")}
          </span>
        ) : (
          waitingFor && <span className="rq__state rq__state--other">{waitingFor}</span>
        )}
      </div>
      <p className="rq__lead">{lead}</p>
      {object && (
        <div className="rq__well">
          <span className="rq__logo">{object.logo}</span>
          <span className="rq__wt">
            <b>{object.title}</b>
            {object.detail && <small>{object.detail}</small>}
          </span>
          {object.more && (details || onOpenChange) && (
            <RequestMore open={open} onClick={toggle}>
              {object.more}
            </RequestMore>
          )}
        </div>
      )}
      {open && details && <div className="rq__details">{details}</div>}
      {onSubmit ? (
        // Only what is filled in and sent is the form (laid out as if it weren't there).
        <form
          className="rq__form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {body}
          {foot}
        </form>
      ) : (
        <>
          {body}
          {foot}
        </>
      )}
    </>
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      ref={root}
      className={muted ? "rq rq--muted" : "rq"}
      role="group"
      aria-label={label}
      data-ask-id={id}
      data-ask-kind={kind}
      data-ask-mine={mine ? "" : undefined}
    >
      {inner}
    </div>
  );
}

/** "Ver …": opens what a request holds back; its arrow turns while it is open. */
function RequestMore({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="rq__more" aria-expanded={open} onClick={onClick}>
      {children}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/**
 * A decided request: no card, one quiet line in the conversation. A pixel mark (a square when it went through, a
 * short bar when it was refused, expired or not applied), its words, and "Ver …" opening the rest under the line.
 */
export function RequestDone({
  done,
  label,
  more,
  action,
  children,
}: {
  /** It went through. */
  done: boolean;
  /** The group's accessible name. */
  label: string;
  /** What the line leaves out, and the button that opens it. */
  more?: { label: string; content: ReactNode };
  /** A button at the line's end (Desfazer). */
  action?: ReactNode;
  /** The words: what it was, how it ended and, when the request has one, the time. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="rq-done" role="group" aria-label={label}>
      <div className="rq-done__line">
        <span className="rq-done__mark" data-done={done || undefined} aria-hidden="true">
          <span />
        </span>
        <span className="rq-done__text">{children}</span>
        {action}
        {more && (
          <RequestMore open={open} onClick={() => setOpen((v) => !v)}>
            {more.label}
          </RequestMore>
        )}
      </div>
      {open && more && <div className="rq__details">{more.content}</div>}
    </div>
  );
}

/** Waiting for you: a small pixel square outline that pulses (also in the bar above the composer). */
export function WaitMark() {
  return (
    <span className="rq-wait" aria-hidden="true">
      <span />
    </span>
  );
}

/** The footer's right end: the fuse burning down to the expiry, and its words. */
export function RequestFuse({ left, agent, text }: { left: number; agent: Agent | undefined; text: ReactNode }) {
  return (
    <>
      <ExpiryFuse left={left} color={colorOf(agent)} />
      {text}
    </>
  );
}

/** The well's logo tile with an icon of ours (a lock, the browser, a document). */
export function RequestTile({ children }: { children: ReactNode }) {
  return <span className="rq__tile">{children}</span>;
}

/** "Ver" in the bar: the request centered on screen, lit up for a moment. */
export function showRequest(root: HTMLElement | null, id: string, smooth: boolean) {
  const card = Array.from(root?.querySelectorAll<HTMLElement>("[data-ask-id]") ?? []).find(
    (el) => el.dataset.askId === id,
  );
  if (!card) return;
  card.scrollIntoView?.({ block: "center", behavior: smooth ? "smooth" : "auto" });
  card.classList.remove("rq--flash");
  // Restarts the animation when it is asked for again.
  void card.offsetWidth;
  card.classList.add("rq--flash");
  card.addEventListener("animationend", () => card.classList.remove("rq--flash"), { once: true });
}
