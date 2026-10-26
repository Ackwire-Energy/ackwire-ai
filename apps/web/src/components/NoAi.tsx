import type { Message } from "@agenteschat/client";
import { useAiStatus } from "@agenteschat/client";
import { withoutApiKeys } from "@agenteschat/client/lib/api-key-text";
import { setupPending } from "@agenteschat/client/lib/computer";
import { aiStateOf, NO_AI, noAiCardOf, opensByItself } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Chip, Dialog, DialogFooter, Icon } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { type ConnectAiRequest, useConnectAi } from "@/components/ConnectAi";
import { useOrg } from "@/components/org-context";
import { useSetupView } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";
import { useChannelEvents } from "@/realtime/context";
import "./no-ai.css";

/*
 * No AI connected (ADR 0061), wherever it shows: above the composer, the agent's card in the
 * conversation, a "Sem IA" chip by its name, and the check before a message with an API key goes out.
 */

/**
 * Above the composer: this DM's agent has no AI, or (anywhere with agents) the organization has none.
 * Everyone sees it; the dialog says what each person may connect. While the workspace's computer is on its way,
 * the organization's says a plan signs in there once it's ready, and a key works now.
 */
export function NoAiBanner({ agentIds, dmAgentId }: { agentIds: string[]; dmAgentId?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const preparing = setupPending(useSetupView(org.id));
  if (!status.data || !connect) return null;
  if (dmAgentId) {
    if (aiStateOf(status.data, dmAgentId) !== "no_ai") return null;
    const name = dir.agentById.get(dmAgentId)?.name ?? t("channel.unknownAgent");
    return (
      <div className="noai-banner" role="status">
        <span className="noai-banner__text ac-iconline">
          <Icon name="plug" size={16} />
          <b>{t("noAi.agent", { name })}</b>
        </span>
        <Button size="sm" onClick={() => connect.open({ agentId: dmAgentId })}>
          {t("noAi.action")}
        </Button>
      </div>
    );
  }
  if (status.data.any || agentIds.length === 0) return null;
  return (
    <div className="noai-banner" role="status">
      <span className="noai-banner__text ac-iconline">
        <Icon name="plug" size={16} />
        <span>
          <b>{t("noAi.banner.org")}</b>{" "}
          {preparing
            ? t("noAi.banner.orgHintPreparing", { computer: t("computerSetup.title", { org: org.name }) })
            : t("noAi.banner.orgHint")}
        </span>
      </span>
      <Button size="sm" onClick={() => connect.open({ agentId: agentIds.length === 1 ? agentIds[0] : undefined })}>
        {t("noAi.banner.orgAction")}
      </Button>
    </div>
  );
}

/**
 * The agent's card in the conversation (`meta.noAi`): it won't answer, with Connect at the step the message
 * asked for. Once its agent has an AI: "Responder agora" (it answers by itself when connected from here).
 */
export function NoAiCard({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const card = noAiCardOf(message.meta);
  if (!card) return null;
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const answer = connect?.answered[message.id];
  const answering = answer === "answering";
  const state = aiStateOf(status.data, card.agentId);
  const ready = state !== undefined && state !== "no_ai" && answer !== "still_missing";
  // The same people as "Continuar": who asked, the agent's owner or an admin.
  const mayAnswer =
    card.forUserId === me.user.id || agent?.ownerUserId === me.user.id || can(org.role, "manage_agents");
  const title = answering
    ? t("noAi.card.answering", { name })
    : ready
      ? t("noAi.card.connected", { name })
      : answer === "still_missing"
        ? t("noAi.card.stillMissing", { name })
        : t("noAi.agent", { name });
  const action =
    !connect || answering ? null : ready || answer === "pending" ? (
      mayAnswer && (
        <Button size="sm" variant="primary" loading={answer === "pending"} onClick={() => connect.answer(message.id)}>
          {t("noAi.card.answerNow")}
        </Button>
      )
    ) : (
      <Button
        size="sm"
        onClick={() =>
          connect.open({ intent: card.intent, provider: card.provider, agentId: card.agentId, from: message.id })
        }
      >
        {t("noAi.action")}
      </Button>
    );
  return (
    <div className="waitcard" data-done={ready || answering || undefined}>
      <span className="waitcard__top ac-iconline">
        <Icon name={ready || answering ? "check" : "plug"} size={16} />
        <span>{title}</span>
      </span>
      {!ready && !answer && card.forUserId === me.user.id && <p>{t("noAi.card.line", { name })}</p>}
      {action && <span className="waitcard__acts">{action}</span>}
    </div>
  );
}

/** "Sem IA" by an agent's name (its page, its profile card); it opens Connect. */
export function NoAiChip({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  if (aiStateOf(status.data, agentId) !== "no_ai") return null;
  const chip = (
    <Chip icon="plug" tone="waiting">
      {t("noAi.chip")}
    </Chip>
  );
  if (!connect) return chip;
  return (
    <button type="button" className="noai-chip" onClick={() => connect.open({ agentId })}>
      {chip}
    </button>
  );
}

/**
 * "Isso parece uma chave de API": before a message with a key goes out (everyone in the chat would read
 * it). Nothing is sent until the person picks; an admin can save it as the organization's key instead.
 */
export function KeyGuardDialog({
  ask,
  onSend,
  onEdit,
  onClose,
}: {
  ask: { text: string; key: string } | null;
  onSend: () => void;
  /** The text without the key, back in the composer. */
  onEdit: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const connect = useConnectAi();
  const admin = connect !== null && can(org.role, "manage_credentials");
  return (
    <Dialog
      open={ask !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("keyGuard.title")}
      description={admin ? t("keyGuard.text") : t("keyGuard.textMember")}
      closeLabel={t("common.close")}
      width={480}
    >
      <DialogFooter>
        <Button onClick={onSend}>{t("keyGuard.send")}</Button>
        <Button variant={admin ? "default" : "primary"} onClick={() => ask && onEdit(withoutApiKeys(ask.text))}>
          {t("keyGuard.remove")}
        </Button>
        {admin && (
          <Button
            variant="primary"
            icon="key"
            onClick={() => {
              if (!ask) return;
              onEdit(withoutApiKeys(ask.text));
              connect.open({ intent: "api_key", apiKey: ask.key });
            }}
          >
            {t("keyGuard.save")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The Connect dialog opens by itself where Jev was sure the person asked to connect an AI: at that step,
 * for the message's author only, once per message in this tab, in a window they're looking at, and never
 * over another dialog. Live events only, so a reload or another tab never opens it again.
 */
export function useNoAiAutoOpen(channelId: string, enabled: boolean) {
  const { org, me } = useOrg();
  const connect = useConnectAi();
  const qc = useQueryClient();
  const authorOf = (messageId: string) => {
    for (const [, list] of qc.getQueriesData<Message[]>({ queryKey: ["org", org.id, "channel", channelId] })) {
      const found = Array.isArray(list) ? list.find((m) => m?.id === messageId && m.author) : undefined;
      if (found) return found.author.id;
    }
    return null;
  };
  useChannelEvents(channelId, enabled && connect !== null, (event) => {
    let target: { id: string; request: ConnectAiRequest } | null = null;
    if (event.type === "message.created" && event.message) {
      const card = noAiCardOf(event.message.meta);
      if (card && card.forUserId === me.user.id && opensByItself(card)) {
        const { intent, provider, agentId } = card;
        target = { id: event.message.id, request: { intent, provider, agentId, from: event.message.id } };
      }
    } else if (event.type === "message.routed" && event.reason === NO_AI && opensByItself(event)) {
      if (authorOf(event.messageId) === me.user.id) {
        const { intent, provider, messageId } = event;
        target = { id: messageId, request: { intent, provider, from: messageId } };
      }
    }
    if (!target || !connect || document.visibilityState !== "visible") return;
    if (document.querySelector('[role="dialog"]')) return;
    const key = `${STORAGE_KEYS.noAiOpened}.${target.id}`;
    if (sessionStore.get(key)) return;
    sessionStore.set(key, "1");
    connect.open({ ...target.request, auto: true });
  });
}
