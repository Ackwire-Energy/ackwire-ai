import { cx } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { agentLine, personLine, useAgentPresence, usePersonPresence } from "@/hooks/usePresence";
import "./presence.css";

/*
 * How a written status shows (ADR 0084): its emoji beside a name, with its words on hover, or emoji and words on a
 * muted line of their own. The data comes from `hooks/usePresence.ts`; the badge is `Avatar`'s `presence`.
 */

/** A line's emoji beside a name: its words on hover and for screen readers. */
export function StatusEmoji({ emoji, text, className }: { emoji: string; text: string; className?: string }) {
  return (
    <span className={cx("status-emoji", className)} role="img" aria-label={text} title={text}>
      {emoji}
    </span>
  );
}

/** Emoji and words, muted, on one line ("📅 Em reunião"); `empty` draws a placeholder fainter. */
export function StatusLine({
  emoji,
  text,
  empty,
  className,
}: {
  emoji?: string | null;
  text: string;
  empty?: boolean;
  className?: string;
}) {
  return (
    <span className={cx("status-line", empty && "status-line--empty", className)}>
      {emoji && (
        <span className="status-line__emoji" aria-hidden="true">
          {emoji}
        </span>
      )}
      <span className="status-line__text">{text}</span>
    </span>
  );
}

/** A message author's line as its emoji beside the name. */
export function AuthorStatus({ actor }: { actor: { type: "agent" | "person"; id: string } }) {
  return actor.type === "agent" ? <AgentAuthorStatus agentId={actor.id} /> : <PersonAuthorStatus userId={actor.id} />;
}

function PersonAuthorStatus({ userId }: { userId: string }) {
  const status = usePersonPresence(userId)?.status;
  const line = status ? personLine(status) : null;
  return line ? <StatusEmoji emoji={line.emoji} text={line.text} className="msg-status" /> : null;
}

function AgentAuthorStatus({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const line = agentLine(t, useAgentPresence(agentId)?.line ?? null, i18n.language);
  return line ? <StatusEmoji emoji={line.emoji} text={line.text} className="msg-status" /> : null;
}
