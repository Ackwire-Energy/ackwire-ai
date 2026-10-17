import { elapsedClock } from "@agenteschat/client";
import { type ActivityEntry, activitySentence, type MarkName } from "@agenteschat/client/lib/activity";
import { Avatar, Icon } from "@agenteschat/ui";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * The working line's pieces (docs/design/telas/ConversaAgentes.html): the
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

/** "0:41" next to a question that is out (Doto); null when nobody is asking. */
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
