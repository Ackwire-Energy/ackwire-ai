import { Button, Icon, Popover } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelThreads } from "@/api/queries";
import type { Message, ThreadInfo, ThreadStartMeta } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { formatTime, relativeTime } from "@/lib/format";
import { threadMessageCount, threadTitle } from "@/lib/threads";
import { ThreadStatusChip } from "./ThreadBits";
import "./threads.css";

/**
 * What a channel shows of its threads (ThreadContexto.html, Threads.html):
 * the quiet marker where a range became a thread's context, the stub once it
 * left the channel, one line per closed thread, and "Threads (N)" in the header.
 */

export interface ChannelThreadsView {
  /** This channel's threads by root id (open and closed; archived ones aren't shown). */
  byId: Map<string, ThreadInfo>;
  /** Messages that are a thread's context and still in the channel: the gutter mark. */
  marks: Set<string>;
}

export const ChannelThreadsContext = createContext<ChannelThreadsView | null>(null);
export const useChannelThreadsView = () => useContext(ChannelThreadsContext);

/**
 * The root of a thread made from a range. In context: "Este trecho virou
 * contexto da thread …" under the range. Moved: the stub "N mensagens
 * movidas para a thread …". Never a normal message.
 */
export function ThreadStartLine({
  message,
  start,
  thread,
}: {
  message: Message;
  start: ThreadStartMeta;
  thread?: ThreadInfo;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const title = thread ? threadTitle(thread) : start.title;
  const moved = thread?.context?.moved ?? start.moved;
  const open = (
    <Button size="sm" variant={moved ? "default" : "ghost"} asChild>
      <Link to="/org/$orgId/threads/$threadId" params={{ orgId: org.id, threadId: message.id }}>
        <Icon name="thread" size={16} />
        {t("threads.line.open")}
      </Link>
    </Button>
  );
  if (moved) {
    const count = start.movedCount || thread?.replyCount || start.count;
    return (
      <div className="thread-stub" data-message-id={message.id}>
        <span className="thread-stub__icon" aria-hidden="true">
          <Icon name="thread" size={16} />
        </span>
        <span className="thread-stub__text">
          {t("threads.line.moved", { count, title })}
          <small>
            {t("threads.line.by", {
              name: dir.authorName(message.author),
              time: formatTime(i18n.language, message.createdAt),
            })}
          </small>
        </span>
        {open}
      </div>
    );
  }
  // In context: one quiet line, its link as text (the range above stays the conversation).
  return (
    <div className="thread-marker" data-message-id={message.id}>
      <Icon name="link" size={14} />
      <span>{t("threads.line.context", { title })}</span>
      <span aria-hidden="true">·</span>
      <Link
        className="thread-marker__open"
        to="/org/$orgId/threads/$threadId"
        params={{ orgId: org.id, threadId: message.id }}
      >
        {t("threads.line.open")}
      </Link>
    </div>
  );
}

/** A closed thread is one compact line in its channel: "Thread fechada · título · N mensagens". */
export function ClosedThreadLine({ thread }: { thread: ThreadInfo }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const params = { orgId: org.id, threadId: thread.id };
  return (
    <div className="thread-closed" data-message-id={thread.id}>
      <Icon name="check" size={16} />
      <span className="thread-closed__text">
        {t("threads.line.closed", { title: threadTitle(thread), count: threadMessageCount(thread) })}
      </span>
      <span className="thread-closed__actions">
        <Button size="sm" variant="ghost" asChild>
          <Link to="/org/$orgId/threads/$threadId" params={params}>
            {t("threads.line.openShort")}
          </Link>
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link to="/org/$orgId/threads/$threadId" params={params} search={{ reply: true }}>
            {t("threads.line.reply")}
          </Link>
        </Button>
      </span>
    </div>
  );
}

/** Under the timeline: archived threads aren't shown here, and where to find them. */
export function ArchivedThreadsNote({ channelId, count }: { channelId: string; count: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  if (count === 0) return null;
  return (
    <div className="thread-closed thread-closed--quiet">
      <Icon name="archiveBox" size={16} />
      <span className="thread-closed__text">{t("threads.line.archived", { count })}</span>
      <span className="thread-closed__actions">
        <Button size="sm" variant="ghost" asChild>
          <Link to="/org/$orgId/threads" params={{ orgId: org.id }} search={{ tab: "archived", channel: channelId }}>
            {t("threads.line.see")}
          </Link>
        </Button>
      </span>
    </div>
  );
}

/** The channel header's "Threads (N)": a popover with this channel's threads and their state. */
export function ChannelThreadsButton({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const list = useChannelThreads(org.id, channelId, "all");
  const archived = useChannelThreads(org.id, channelId, "archived");
  const threads = list.data?.threads ?? [];
  const more = Boolean(list.data?.nextCursor);
  const count = more ? t("threads.popover.many", { count: threads.length }) : String(threads.length);
  const archivedCount = archived.data?.threads.length ?? 0;
  const go = (threadId: string) => {
    setOpen(false);
    void navigate({ to: "/org/$orgId/threads/$threadId", params: { orgId: org.id, threadId } });
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      className="thread-pop"
      label={t("threads.popover.label", { channel: channelName })}
      trigger={
        <Button size="sm" icon="thread" aria-label={t("threads.popover.button", { count: threads.length })}>
          <span className="thread-pop__label">{t("threads.popover.title")}</span>
          <span className="thread-pop__count">{count}</span>
        </Button>
      }
    >
      <div className="thread-pop__head">
        <b>{t("threads.popover.in", { channel: channelName })}</b>
        <small>
          {archivedCount > 0
            ? t("threads.popover.countArchived", { count: threads.length, archived: archivedCount })
            : threads.length}
        </small>
      </div>
      {threads.length === 0 && <p className="thread-pop__empty">{t("threads.popover.empty")}</p>}
      <div className="thread-pop__list">
        {threads.map((thread) => (
          <button key={thread.id} type="button" className="thread-pop__row" onClick={() => go(thread.id)}>
            <span className="thread-kind" aria-hidden="true">
              <Icon name="thread" size={14} />
            </span>
            <span className="thread-pop__text">
              <b>{threadTitle(thread)}</b>
              <small>
                {t("threads.messages", { count: threadMessageCount(thread) })} ·{" "}
                {relativeTime(t, i18n.language, thread.lastActivityAt)}
              </small>
            </span>
            <ThreadStatusChip thread={thread} />
          </button>
        ))}
      </div>
      {/* TODO(missions): "Nova missão aqui" goes in this footer when missions land (ADR 0029 §3). */}
      <div className="thread-pop__foot">
        <Button size="sm" asChild>
          <Link
            to="/org/$orgId/threads"
            params={{ orgId: org.id }}
            search={{ channel: channelId }}
            onClick={() => setOpen(false)}
          >
            {t("threads.popover.seeAll")}
            <Icon name="chevronRight" size={16} />
          </Link>
        </Button>
      </div>
    </Popover>
  );
}
