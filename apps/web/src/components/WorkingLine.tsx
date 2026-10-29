import { elapsedClock, type LiveRun } from "@agenteschat/client";
import {
  type ActivityEntry,
  activitySentence,
  barPhrase,
  type MarkName,
  PHRASE_TURN_MS,
} from "@agenteschat/client/lib/activity";
import { Avatar, Icon } from "@agenteschat/ui";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * The working line's pieces: the
 * stacked live mini bodies of who is on it, the sentence with names in ink
 * ("Theo, Iris e mais 2 estão trabalhando…", "Dev está perguntando ao
 * Infra…") and the clock of a question that is out.
 */

/** How many mini bodies the stack shows (the sentence says "e mais N"). */
export const STACK_MAX = 4;

// Names travel through i18n wrapped in these, then come back as <b>.
const OPEN = "\u0001";
const CLOSE = "\u0002";
const mark: MarkName = (name) => `${OPEN}${name}${CLOSE}`;

/** Splits a marked sentence into text and bold names. */
export function boldNames(text: string): ReactNode[] {
  const [head = "", ...rest] = text.split(OPEN);
  const out: ReactNode[] = head ? [head] : [];
  rest.forEach((part, i) => {
    const at = part.indexOf(CLOSE);
    const name = at < 0 ? part : part.slice(0, at);
    const after = at < 0 ? "" : part.slice(at + 1);
    // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
    out.push(<b key={i}>{name}</b>);
    if (after) out.push(after);
  });
  return out;
}

/** The sentence with names in bold (its text content equals `activityText`). */
export function WorkingWords({ entries }: { entries: ActivityEntry[] }) {
  const { t } = useTranslation();
  return <>{boldNames(activitySentence(t, entries, mark))}</>;
}

/**
 * The card's phrase, turning: one agent on its own gets a light line
 * while it only thinks, then what it does, an aside on a long step and what it said last, in turn.
 */
export function BarPhrase({ entries, runs }: { entries: ActivityEntry[]; runs: LiveRun[] }) {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  const turning = entries.length === 1 && entries[0]?.type === "agent";
  useEffect(() => {
    if (!turning) return;
    const timer = setInterval(() => setTick((n) => n + 1), PHRASE_TURN_MS);
    return () => clearInterval(timer);
  }, [turning]);
  return <TurnText text={barPhrase(t, entries, runs, tick, Date.now(), mark)} />;
}

/**
 * A new phrase comes up from below while the old one leaves upward (just a swap with reduced motion).
 * The one leaving is drawn from an attribute, so the text on the page is only the phrase now.
 */
function TurnText({ text }: { text: string }) {
  const [shown, setShown] = useState({ now: text, was: null as string | null, n: 0 });
  if (shown.now !== text) setShown({ now: text, was: shown.now, n: shown.n + 1 });
  return (
    <span className="ac-turn">
      {shown.was !== null && (
        <span
          key={`was-${shown.n}`}
          className="ac-turn__out"
          aria-hidden="true"
          data-text={shown.was.split(OPEN).join("").split(CLOSE).join("")}
          onAnimationEnd={() => setShown((s) => (s.n === shown.n ? { ...s, was: null } : s))}
        />
      )}
      <span key={`now-${shown.n}`} className="ac-turn__in" data-first={shown.n === 0 || undefined}>
        {boldNames(shown.now)}
      </span>
    </span>
  );
}

/**
 * The stacked mini bodies: each on a plate so overlaps stay readable. An
 * agent asking another shows both, with an arrow (the one asked is thinking).
 */
export function WorkingStack({ entries }: { entries: ActivityEntry[] }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const shown = entries.filter((e) => e.type === "agent").slice(0, STACK_MAX);
  const people = entries.filter((e) => e.type === "person");
  const tok = (key: string, node: ReactNode) => (
    <span key={key} className="ac-typing__tok">
      {node}
    </span>
  );
  return (
    <span className="ac-typing__avatars" aria-hidden="true">
      {shown.map((e) => {
        const c = e.consult;
        if (c?.status === "asking")
          return (
            <Fragment key={`c:${e.id}`}>
              {tok(`a:${e.id}`, <AgentAvatar agentId={e.id} size="xs" name={e.name} state="idle" />)}
              <span className="ac-typing__to">
                <Icon name="arrowRight" size={14} />
              </span>
              {tok(`t:${c.to}`, <AgentAvatar agentId={c.to} size="xs" name={c.toName} state="thinking" />)}
            </Fragment>
          );
        return tok(`a:${e.id}`, <AgentAvatar agentId={e.id} size="xs" name={e.name} state="writing" />);
      })}
      {people.map((e) =>
        tok(`p:${e.id}`, <Avatar size="xs" name={e.name} imageUrl={dir.memberById.get(e.id)?.image} />),
      )}
    </span>
  );
}

/** "0:41" next to a question that is out (tabular figures); null when nobody is asking. */
export function ConsultClock({ entries, now }: { entries: ActivityEntry[]; now: number }) {
  const { t } = useTranslation();
  const asking = entries.find((e) => e.consult?.status === "asking")?.consult;
  if (!asking) return null;
  const time = elapsedClock(now - asking.since);
  return (
    <span className="ac-typing__clock ac-num" role="timer" aria-label={t("chat.consult.clock", { time })}>
      {time}
    </span>
  );
}
