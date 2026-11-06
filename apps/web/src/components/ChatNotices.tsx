import type { Agent, Message } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { APP_BRANDS } from "@agenteschat/client/lib/apps";
import { seesDetails } from "@agenteschat/client/lib/audience";
import { pairItemOf } from "@agenteschat/client/lib/consult-group";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  consultationOfNotice,
  followUpLine,
  type MessageNotice,
  noticeAgentHandle,
  noticeOf,
  noticeRoutineName,
  type StoppedNotice,
  skippedHandles,
  stoppedNoticeOf,
} from "@agenteschat/client/lib/notices";
import type { RoutineReply } from "@agenteschat/client/lib/routines";
import type { AppVia } from "@agenteschat/client/lib/via";
import { cx, Icon, type IconName, PixelStop, ProviderLogo } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { MessageBody } from "@/chat/MessageBody";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { ConsultPairRow } from "@/components/ConsultGroup";
import { DetailsLink } from "@/components/details-link";
import { useOrg } from "@/components/org-context";
import { SayWhy } from "@/components/tasks/TaskBits";
import { useDirectory } from "@/hooks/useDirectory";
import "./chat-notices.css";

const NOTICE_ICON: Record<string, IconName> = {
  routine_handoff: "routines",
  consult_reply: "agent",
  agent_note: "message",
  wait_result: "check",
  follow_up: "clock",
  wake_skipped: "alert",
};

/** The line's words: the app's own, never the agent-facing `from` ("Routine «…»") as is. */
function noticeLabel(
  t: TFunction,
  notice: MessageNotice,
  agentName: string,
  nameOfHandle: (handle: string) => string | null,
): string {
  const handle = noticeAgentHandle(notice);
  // The agent's name, without the @ of its handle (`from` is written for the agent).
  const from = handle ? (nameOfHandle(handle) ?? handle) : notice.from;
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
    case "wake_skipped":
      return t("chat.notice.wakeSkipped", {
        name: agentName,
        agents: skippedHandles(notice)
          .map((h) => nameOfHandle(h) ?? h)
          .join(", "),
      });
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
  action,
}: {
  message: Message;
  icon: IconName;
  label: ReactNode;
  text: string;
  labels: { show: string; hide: string };
  /** What a person can still do about it ("Cancelar" on a follow-up), at the end of the line. */
  action?: ReactNode;
}) {
  const { i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  return (
    <div className="cn-line ac-iconline" data-message-id={message.id}>
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
        {action && (
          <>
            {" · "}
            {action}
          </>
        )}
      </span>
      {open && text && (
        <div className="cn-line__body">
          <MessageBody body={text} resolveMention={dir.mentionName} mentionTone={dir.mentionTone} />
        </div>
      )}
    </div>
  );
}

/**
 * In place of a conversation row, or a `part` of a message (a card, its receipts), that failed to draw
 * (`ErrorBoundary`): one quiet line, the rest keeps working.
 */
export function UnshownLine({ part = false }: { part?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={cx("cn-line ac-iconline", part && "cn-line--part")}>
      <Icon name="alert" size={14} />
      <span className="cn-line__text">{t(part ? "chat.unshownPart" : "chat.unshown")}</span>
    </div>
  );
}

/**
 * What reached an agent's conversation while it wasn't looking (`meta.notice`): "Rotina «Sentry»
 * entregou um relatório", "Infra respondeu", "Nota de Dev", "Chegou o resultado que Ada esperava".
 * The agent's own reply (if it has something to say) follows as a normal message.
 */
export function NoticeLine({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const notice = noticeOf(message.meta);
  if (!notice) return null;
  // A person stopped one of the agent's tasks (ADR 0128): its own calm line, with "Dizer por quê" for who stopped it.
  const stopped = stoppedNoticeOf(message.meta);
  if (stopped) return <StoppedLine message={message} notice={stopped} />;
  // Another agent's answer with its consultation, its reply not here: the same pair row a reply has (who asked
  // whom), never the text written for the asking agent; a click opens what they said.
  const consulted = consultationOfNotice(message.meta);
  if (consulted)
    return (
      <div data-message-id={message.id}>
        <ConsultPairRow askerId={consulted.askerId} items={[pairItemOf(consulted.consultation)]} />
      </div>
    );
  const nameOfHandle = (handle: string) => dir.agentByHandle.get(handle.toLowerCase())?.name ?? null;
  const name = dir.authorName(message.author);
  const followUp = followUpLine(notice, name, { time: (iso) => formatTime(i18n.language, iso), locale: i18n.language });
  return (
    <EventLine
      message={message}
      icon={NOTICE_ICON[notice.kind] ?? "info"}
      label={followUp ? t(followUp.key, followUp.values) : noticeLabel(t, notice, name, nameOfHandle)}
      text={message.body.trim() || notice.text}
      labels={{ show: t("chat.notice.show"), hide: t("chat.notice.hide") }}
      action={followUp?.pending ? <CancelFollowUp messageId={message.id} /> : undefined}
    />
  );
}

/** Under a reply that came at standard speed because Fast was refused (`meta.speedFallback`), with the way to the agent. */
export function SpeedFallbackLine({ agent }: { agent: Agent | undefined }) {
  const { t } = useTranslation();
  const openPanel = useOpenAgentPanel();
  return (
    <div className="cn-line cn-line--part ac-iconline">
      <Icon name="info" size={14} />
      <span className="cn-line__text">
        {t("chat.speedFallback.text")}
        {openPanel && agent && seesDetails(agent) && (
          <>
            {" "}
            <button type="button" className="ac-link" onClick={() => openPanel(agent.id)}>
              {t("chat.speedFallback.action")}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * "You stopped Dev · Waits until someone asks to continue." and the reason when one was said. Who stopped it can
 * still say why ("Add a reason": a field and Send, in the line); the agent reads it on its next turn.
 */
function StoppedLine({ message, notice }: { message: Message; notice: StoppedNotice }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  // Shown at once; the notice's own copy follows when the conversation hears of it.
  const [sent, setSent] = useState<string | null>(null);
  const mine = notice.byUserId === me.user.id;
  const reason = notice.reason ?? sent;
  const stopper = notice.byName || dir.memberById.get(notice.byUserId)?.name || "";
  const agent = message.author.type === "agent" ? dir.authorName(message.author) : t("channel.unknownAgent");
  const { context } = agentGrammar(agent);
  return (
    <div className="cn-line ac-iconline cn-stopped" data-message-id={message.id}>
      <PixelStop size={12} dim />
      <span className="cn-line__text">
        <b>
          {mine
            ? t("taskManager.stopped.line", { agent, context })
            : t("taskManager.stopped.lineBy", { name: stopper, agent, context })}
        </b>
        {" · "}
        {t("taskManager.stopped.told")}
        {reason && ` ${t("taskManager.stopped.reason", { reason })}`}
        {mine && !reason && !asking && (
          <>
            {" · "}
            <button type="button" className="cn-line__toggle" onClick={() => setAsking(true)}>
              {t("taskManager.stopped.sayWhy")}
            </button>
          </>
        )}
      </span>
      {asking && !reason && (
        <SayWhy
          runId={notice.runId}
          className="cn-stopped__why"
          autoFocus
          onCancel={() => setAsking(false)}
          onSent={(why) => {
            setSent(why);
            setAsking(false);
            void qc.invalidateQueries({ queryKey: keys.messages(org.id, message.channelId) });
          }}
        />
      )}
    </div>
  );
}

/** "Cancelar" on a follow-up still to come: the line changes in place once the server has it. */
function CancelFollowUp({ messageId }: { messageId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const { org } = useOrg();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="cn-line__toggle"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void api.chat
          .cancelFollowUp(org.id, messageId)
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    >
      {t("chat.notice.followUpCancel")}
    </button>
  );
}

/**
 * The routine an agent's message answers (ADR 0053 §7): a small tag next to its name, "Rotina «X»",
 * that opens the routine's details in place (`DetailsLink`); with the report it answers loaded here, "Ver relatório" unfolds it
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
  return (
    <>
      <DetailsLink
        item={{ kind: "routine", id: routine.id }}
        className="msg-reminder msg-reminder--link"
        title={t("channel.routineTagTip")}
      >
        <Icon name="routines" size={14} />
        {t("channel.routineTag", { name: routine.name })}
      </DetailsLink>
      {report && (
        <button type="button" className="cn-line__toggle cn-report__toggle" aria-expanded={open} onClick={onToggle}>
          {open ? t("channel.routineReportHide") : t("channel.routineReport")}
        </button>
      )}
    </>
  );
}

/** A person's message sent through a connected AI app (ADR 0119): "via Claude", with the app's mark when known. */
export function AppViaTag({ via, person }: { via: AppVia; person: string }) {
  const { t } = useTranslation();
  const mark = via.brand ? APP_BRANDS[via.brand] : undefined;
  return (
    <span className="msg-reminder msg-via" title={t("apps.viaTip", { person, name: via.name })}>
      {mark ? <ProviderLogo id={mark} size="xs" /> : <Icon name="link" size={14} />}
      {t("apps.via", { name: via.name })}
    </span>
  );
}

/** The report a routine's message answers, unfolded under it (its words, as the notice had them). */
export function RoutineReport({ text }: { text: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (
    <div className="cn-report">
      <MessageBody body={text} resolveMention={dir.mentionName} mentionTone={dir.mentionTone} />
    </div>
  );
}
