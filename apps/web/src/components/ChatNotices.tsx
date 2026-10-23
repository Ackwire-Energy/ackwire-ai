import type { Message } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { type MessageNotice, noticeAgentHandle, noticeOf, noticeRoutineName } from "@agenteschat/client/lib/notices";
import type { RoutineReply } from "@agenteschat/client/lib/routines";
import { Icon, type IconName } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
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
  agentName: string,
  nameOfHandle: (handle: string) => string | null,
): string {
  const handle = noticeAgentHandle(notice);
  const from = handle ? `@${nameOfHandle(handle) ?? handle}` : notice.from;
  switch (notice.kind) {
    case "routine_handoff": {
      const routine = noticeRoutineName(notice);
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
      label={noticeLabel(t, notice, dir.authorName(message.author), nameOfHandle)}
      text={message.body.trim() || notice.text}
      labels={{ show: t("chat.notice.show"), hide: t("chat.notice.hide") }}
    />
  );
}

/**
 * The routine an agent's message answers (ADR 0053 §7): a small tag next to its name, "Rotina «X»",
 * that opens the routine in Rotinas; with the report it answers loaded here, "Ver relatório" unfolds it
 * (the report's own line is folded into this message).
 */
export function RoutineTag({
  routine,
  report,
  open,
  onToggle,
}: {
  routine: RoutineReply;
  report: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <>
      <Link
        to="/org/$orgId/routines"
        params={{ orgId: org.id }}
        search={{ open: routine.id }}
        className="msg-reminder msg-reminder--link"
        title={t("channel.routineTagTip")}
      >
        <Icon name="routines" size={14} />
        {t("channel.routineTag", { name: routine.name })}
      </Link>
      {report && (
        <button type="button" className="cn-line__toggle cn-report__toggle" aria-expanded={open} onClick={onToggle}>
          {open ? t("channel.routineReportHide") : t("channel.routineReport")}
        </button>
      )}
    </>
  );
}

/** The report a routine's message answers, unfolded under it (its words, as the notice had them). */
export function RoutineReport({ text }: { text: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (
    <div className="cn-report">
      <MessageBody body={text} resolveMention={dir.mentionName} />
    </div>
  );
}
