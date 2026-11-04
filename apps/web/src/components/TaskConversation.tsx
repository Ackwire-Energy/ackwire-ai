import type { Issue } from "@agenteschat/client";
import { runsInChannel, useTaskConversation } from "@agenteschat/client";
import { conversationLine } from "@agenteschat/client/lib/issues";
import { Button, CountChip, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { ThreadLineBody } from "@/components/threads/ThreadLines";
import { ChannelSkeleton } from "@/pages/ChannelPage";
import { ThreadPage } from "@/pages/ThreadPage";
import { useStreams } from "@/realtime/context";
import "@/components/threads/threads.css";

/*
 * A task's conversation (ADR 0144): the app's own thread panel, as a column of the task's dialog or page. Its
 * messages, composer, runs, receipts and stop are the chat's; the task's card and dialog read its line.
 */

/** Someone's turn is live in it now (the card's `working` lags until it refetches). */
function useWorking(issue: Pick<Issue, "conversation">) {
  const channelId = issue.conversation?.channelId;
  const live = useStreams((s) => (channelId ? runsInChannel(s, channelId).length > 0 : false));
  return Boolean(issue.conversation?.working) || live;
}

/** "Conversa 5" on the task dialog's top bar: opens or closes the conversation beside the details. */
export function TaskConversationButton({
  issue,
  open,
  onToggle,
}: {
  issue: Issue;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const count = issue.conversation?.count ?? 0;
  return (
    <Button
      size="sm"
      variant={open ? "default" : "ghost"}
      icon="message"
      aria-pressed={open}
      aria-label={count > 0 ? t("issues.conversation.toggle", { count }) : t("issues.conversation.button")}
      className="task-talk__toggle"
      onClick={onToggle}
    >
      {t("issues.conversation.button")}
      {count > 0 && <CountChip size="sm">{count}</CountChip>}
    </Button>
  );
}

/**
 * Where "Discussão" was: one line that opens the conversation. Who took part, "6 mensagens", "Trabalhando" while
 * an agent is at it, when it last moved; nobody yet: "Conversar sobre a tarefa".
 */
export function TaskConversationSummary({ issue, onOpen }: { issue: Issue; onOpen: () => void }) {
  const { t } = useTranslation();
  const line = conversationLine(issue);
  const working = useWorking(issue);
  return (
    <button type="button" className="task-talk__summary" onClick={onOpen}>
      <Icon name="message" size={16} />
      {line ? (
        <>
          <ConversationLineBody line={line} working={working} />
          <span className="task-talk__open">{t("issues.conversation.open")}</span>
        </>
      ) : (
        <span>{t("issues.conversation.start")}</span>
      )}
      <Icon name="chevronRight" size={16} className="task-talk__chev" />
    </button>
  );
}

/** A board card's last line: the chat's thread line (who, "6 mensagens", "Trabalhando", when). None: nothing. */
export function TaskCardConversation({ issue }: { issue: Issue }) {
  const line = conversationLine(issue);
  const working = useWorking(issue);
  if (!line) return null;
  return (
    <span className="thread-line issue-card__talk">
      <ConversationLineBody line={line} working={working} />
    </span>
  );
}

function ConversationLineBody({
  line,
  working,
}: {
  line: NonNullable<ReturnType<typeof conversationLine>>;
  working: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ThreadLineBody
      people={line.people}
      label={t("issues.conversation.messages", { count: line.count })}
      status={working ? "working" : undefined}
      at={line.lastAt}
    />
  );
}

/** The conversation as a column: the thread panel itself, at `focusMessageId` when a link or a notice named one. */
export function TaskConversationPanel({
  issue,
  focusMessageId,
  onClose,
}: {
  issue: Issue;
  focusMessageId?: string;
  onClose: () => void;
}) {
  const { org } = useOrg();
  const at = useTaskConversation(org.id, issue, true);
  if (!at) return <ChannelSkeleton thread panel />;
  return <ThreadPage threadId={at.rootId} focusMessageId={focusMessageId} onClose={onClose} />;
}
