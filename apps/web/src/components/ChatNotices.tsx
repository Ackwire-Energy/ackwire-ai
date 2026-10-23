import type { Message } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import {
  backgroundRoutineOf,
  type MessageNotice,
  noticeAgentHandle,
  noticeOf,
  noticeRoutineName,
} from "@agenteschat/client/lib/notices";
import { Icon, type IconName } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import "./chat-notices.css";

const NOTICE_ICON: Record<string, IconName> = {
  routine_handoff: "routines",
  consult_reply: "agent",
  agent_note: "message",
  wait_result: "check",
};

/** The line's words: the app's own, never the agent-facing `from` ("Routine «…»") as is. */
function noticeLabel(
  t: TFunction,
  notice: MessageNotice,
  meta: Message["meta"],
  agentName: string,
  nameOfHandle: (handle: string) => string | null,
): string {
  const handle = noticeAgentHandle(notice);
  const from = handle ? `@${nameOfHandle(handle) ?? handle}` : notice.from;
  switch (notice.kind) {
    case "routine_handoff": {
      const routine = noticeRoutineName(meta, notice);
      return routine ? t("chat.notice.routineHandoff", { routine }) : t("chat.notice.routineHandoffAnon");
    }
    case "consult_reply":
      return from ? t("chat.notice.consultReply", { from }) : t("chat.notice.consultReplyAnon");
    case "agent_note":
      return from ? t("chat.notice.agentNote", { from }) : t("chat.notice.agentNoteAnon");
    case "wait_result":
      return t("chat.notice.waitResult", { name: agentName });
    default:
      return t("chat.notice.other", { name: agentName });
  }
}

/**
 * One quiet line with its text on demand ("Ver"): an automatic line of the conversation, not a voice.
 */
function EventLine({
  message,
  icon,
  label,
  text,
  labels,
}: {
  message: Message;
  icon: IconName;
  label: ReactNode;
  text: string;
  labels: { show: string; hide: string };
}) {
  const { i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  return (
    <div className="cn-line" data-message-id={message.id}>
      <Icon name={icon} size={14} />
      <span className="cn-line__text">
        {label} · {formatTime(i18n.language, message.createdAt)}
        {text && (
          <>
            {" · "}
            <button type="button" className="cn-line__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? labels.hide : labels.show}
            </button>
          </>
        )}
      </span>
      {open && text && (
        <div className="cn-line__body">
          <MessageBody body={text} resolveMention={dir.mentionName} />
        </div>
      )}
    </div>
  );
}

/**
 * What reached an agent's conversation while it wasn't looking (`meta.notice`): "Rotina «Sentry»
 * entregou um relatório", "@Infra respondeu", "Nota de @Dev", "Chegou o resultado que Ada esperava".
 * The agent's own reply (if it has something to say) follows as a normal message.
 */
export function NoticeLine({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const notice = noticeOf(message.meta);
  if (!notice) return null;
  const nameOfHandle = (handle: string) => dir.agentByHandle.get(handle.toLowerCase())?.name ?? null;
  return (
    <EventLine
      message={message}
      icon={NOTICE_ICON[notice.kind] ?? "info"}
      label={noticeLabel(t, notice, message.meta, dir.authorName(message.author), nameOfHandle)}
      text={message.body.trim() || notice.text}
      labels={{ show: t("chat.notice.show"), hide: t("chat.notice.hide") }}
    />
  );
}

/**
 * A routine ran in the background (`meta.background`): one line where its start was posted, never
 * as the person who created it; its instructions on demand. Its report comes as a notice.
 */
export function RoutineRanLine({ message }: { message: Message }) {
  const { t } = useTranslation();
  const routine = backgroundRoutineOf(message.meta);
  if (!routine) return null;
  return (
    <EventLine
      message={message}
      icon="routines"
      label={t("chat.notice.routineRan", { routine: routine.name })}
      text={message.body.trim()}
      labels={{ show: t("channel.routineShow"), hide: t("channel.routineHide") }}
    />
  );
}
