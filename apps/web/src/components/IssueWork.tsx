import { type Message, useIssue } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { type IssueWorkRef, issueTakenOf, STATUS_ICON } from "@agenteschat/client/lib/issues";
import { Chip, EventPill, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useInPlace } from "@/components/InPlace";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { inPlaceClick } from "@/lib/navigate";
import "./issue-work.css";

/**
 * The root of an issue's work thread, in the requester's DM with the agent:
 * "Você pediu a issue #24", its title, its status (live) and "Ver issue" (its dialog, over the conversation).
 * The agent's instructions never show here: they live in its run's context.
 */
export function IssueWorkCard({ work, authorId }: { work: IssueWorkRef; authorId: string | null }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const issue = useIssue(org.id, work.number);
  const status = issue.data?.id === work.issueId ? issue.data.status : null;
  const agent = work.agentId ? dir.agentById.get(work.agentId) : undefined;
  const asker = authorId && authorId !== me.user.id ? dir.memberById.get(authorId)?.name : null;
  const inPlace = useInPlace();
  return (
    <section className="iw-card" aria-label={t("chat.issueWork.label")}>
      <div className="iw-card__h">
        <span className="iw-card__ic">
          <Icon name="issues" size={16} />
        </span>
        <span className="iw-card__who">
          {asker ? t("chat.issueWork.askedBy", { name: asker }) : t("chat.issueWork.asked")}{" "}
          <span className="tabular">#{work.number}</span>
        </span>
        {status && <Chip icon={STATUS_ICON[status]}>{t(`issues.status.${status}`)}</Chip>}
      </div>
      <div className="iw-card__t">{issue.data?.title ?? work.title}</div>
      <div className="iw-card__f">
        {agent && (
          <span className="iw-card__agent small muted">
            <AgentAvatar agentId={agent.id} name={agent.name} state="idle" size="xs" />
            {t("chat.issueWork.agent", { name: agent.name })}
          </span>
        )}
        <Link
          to="/org/$orgId/issues/$number"
          params={{ orgId: org.id, number: String(work.number) }}
          className="ac-link iw-card__open"
          onClick={inPlace ? (e) => inPlaceClick(e, () => inPlace.issue(work.number)) : undefined}
        >
          {t("chat.issueWork.view")}
          <Icon name="arrowRight" size={14} />
        </Link>
      </div>
    </section>
  );
}

/** Where the issue came from (a channel message): one event pill, "Ada took task #24 · its title", linking to it. */
export function IssueTakenLine({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const inPlace = useInPlace();
  const taken = issueTakenOf(message.meta);
  if (!taken) return null;
  const name = dir.authorName(message.author);
  return (
    <EventPill
      className="iw-line"
      data-message-id={message.id}
      mark={<Icon name="issues" size={14} />}
      time={formatTime(i18n.language, message.createdAt)}
    >
      {t("chat.issueWork.taken", { name })}{" "}
      <Link
        to="/org/$orgId/issues/$number"
        params={{ orgId: org.id, number: String(taken.number) }}
        className="iw-line__link"
        onClick={inPlace ? (e) => inPlaceClick(e, () => inPlace.issue(taken.number)) : undefined}
      >
        <span className="tabular">#{taken.number}</span> · {taken.title}
      </Link>
    </EventPill>
  );
}
