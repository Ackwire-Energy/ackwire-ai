import { type Message, useConsultationConversation } from "@agenteschat/client";
import { consultLineState } from "@agenteschat/client/lib/consult-group";
import { dayLabel, formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { buildTimeline } from "@agenteschat/client/lib/timeline";
import { AvatarStack, Button, DayDivider, Icon, PixelSpinner } from "@agenteschat/ui";
import { Fragment, type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { consultLineLabel } from "@/components/ConsultGroup";
import { ChannelActionsContext } from "@/components/channel-actions";
import { ErrorState, LoadingConversation } from "@/components/Loading";
import { useNow } from "@/components/missions/MissionBits";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * A question an agent asked another from this conversation, opened over it like a thread ("Theo ⇄ Iris", from its
 * line in the reply's block): the question as it went to the other agent, what that agent wrote, and the cards it
 * posted here (an approval, a question, a secret request), drawn as the conversation draws them (`renderMessage`).
 * Read only: people don't write in the agents' DM; to change course they talk to the agent that asked (`onTalk`
 * puts its handle in the composer). The DM sends this page no events: it reloads while the question is out.
 */
export function ConsultationPanel({
  channelId,
  channelName,
  consultationId,
  onClose,
  onTalk,
  renderMessage,
}: {
  /** The conversation that asked (its access opens the question). */
  channelId: string;
  channelName: string;
  consultationId: string;
  onClose: () => void;
  /** "Falar com o Theo": closes the panel and mentions the agent that asked. */
  onTalk: (handle: string) => void;
  renderMessage: (message: Message, grouped: boolean) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const query = useConsultationConversation(org.id, channelId, consultationId);
  const c = query.data?.consultation;
  const list = query.data?.messages;
  const now = useNow(c?.status === "open");
  const items = useMemo(() => buildTimeline(list ?? [], [], []), [list]);
  const asker = c ? dir.agentById.get(c.agentId) : undefined;
  const consulted = c ? dir.agentById.get(c.consultedAgentId) : undefined;
  const from = agentGrammar(t, asker?.name ?? t("channel.unknownAgent"));
  const to = agentGrammar(t, consulted?.name ?? t("channel.unknownAgent"));
  const label = t("chat.consultPanel.label", {
    from: from.name,
    articleFrom: from.article,
    to: to.name,
    articleTo: to.article,
  });
  const state = c ? consultLineState(c, now) : null;

  const rows: ReactNode[] = [];
  for (const item of items) {
    if (item.kind === "day") rows.push(<DayDivider key={item.key}>{dayLabel(t, i18n.language, item.iso)}</DayDivider>);
    else if (item.kind === "message")
      rows.push(<Fragment key={item.key}>{renderMessage(item.message, item.grouped)}</Fragment>);
  }

  return (
    <>
      <button
        type="button"
        className="thread-panel__scrim"
        tabIndex={-1}
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <aside className="thread-panel" aria-label={label}>
        <section className="shell__main shell__main--chat thread-panel__chat">
          <header className="channel__header thread-head thread-head--panel">
            <span className="thread-head__who" aria-hidden="true">
              {c && (
                <AvatarStack>
                  <AgentAvatar agentId={c.agentId} size="sm" name={from.name} state="idle" />
                  <AgentAvatar
                    agentId={c.consultedAgentId}
                    size="sm"
                    name={to.name}
                    state={state === "working" ? "thinking" : state === "waiting" ? "waiting" : "idle"}
                  />
                </AvatarStack>
              )}
            </span>
            <div className="thread-head__text">
              <h1 className="channel__title thread-title consult-title">
                {from.name}
                <Icon name="swap" size={16} label={t("newAgent.and")} />
                {to.name}
              </h1>
              <span className="channel__topic thread-head__meta">
                <span className="thread-head__where">{t("chat.consultPanel.where", { channel: channelName })}</span>
                {list && list.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{t("chat.consultPanel.messages", { count: list.length })}</span>
                  </>
                )}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={onClose}
            />
          </header>

          {/* The messages act on nothing here: no reply, no thread, no quote (they live in the agents' DM). */}
          <ChannelActionsContext.Provider value={null}>
            <section className="channel__messages" aria-label={label}>
              <div className="channel__spacer" aria-hidden="true" />
              {query.isLoading && <LoadingConversation />}
              {query.isError && !query.data && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
              {query.isSuccess && !query.data && <p className="thread-origin">{t("chat.consultPanel.missing")}</p>}
              {c && (
                <p className="thread-origin ac-iconline">
                  <Icon name="agent" size={14} />
                  <span>
                    {t("chat.consultPanel.origin", {
                      from: from.name,
                      toArticle: to.to,
                      to: to.name,
                      channel: channelName,
                      time: formatTime(i18n.language, c.createdAt),
                    })}
                  </span>
                </p>
              )}
              {rows}
              {c && state && state !== "answered" && (
                <p className="cn-line ac-iconline" aria-live="polite">
                  {state === "working" ? (
                    <PixelSpinner size={14} color={colorOf(consulted)} />
                  ) : (
                    <Icon name={state === "waiting" || state === "offline" ? "waiting" : "clock"} size={14} />
                  )}
                  <span className="cn-line__text">{consultLineLabel(t, state, c, to)}</span>
                </p>
              )}
            </section>
          </ChannelActionsContext.Provider>

          <div className="channel__composer">
            <div className="thread-archived" role="note">
              <span className="ac-iconline">
                <Icon name="lock" size={16} />
                <span>
                  <b>{t("chat.consultPanel.readOnly")}</b>{" "}
                  {t("chat.consultPanel.steer", { name: from.name, article: from.article })}
                </span>
              </span>
              {asker && (
                <Button size="sm" icon="message" onClick={() => onTalk(asker.handle)}>
                  {t("chat.consultPanel.talk", { name: from.name, article: from.article })}
                </Button>
              )}
            </div>
          </div>
        </section>
      </aside>
    </>
  );
}
