import type { Agent } from "@agenteschat/client";
import { ExpiryFuse } from "@agenteschat/ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { CardSky, colorOf } from "./Sky";
import "./request-card.css";

/** What an agent can ask of a person in the conversation: each says so in the card's header and in the bar. */
export type RequestKind = "approval" | "secret" | "question" | "browser" | "desktop" | "proposal";

/**
 * One card for every request an agent makes in the conversation, so each reads the same way and its decision
 * sits in the same place: a quiet header (what kind of request, and whether it waits for you), the agent's own
 * words, the object in a well of two lines with "Ver …" opening it whole, anything to fill in, and the footer
 * strip with the decision on the left and the time left on the right.
 *
 * The root carries `data-ask-*` so the bar above the composer can say a request is waiting while it is out of
 * view, and bring it back.
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
}) {
  const { t } = useTranslation();
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
            <button type="button" className="rq__more" aria-expanded={open} onClick={toggle}>
              {object.more}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
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
      className="rq"
      role="group"
      aria-label={label}
      data-ask-id={id}
      data-ask-kind={kind}
      data-ask-agent={agent?.id ?? ""}
      data-ask-what={what}
      data-ask-mine={mine ? "" : undefined}
    >
      {inner}
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
