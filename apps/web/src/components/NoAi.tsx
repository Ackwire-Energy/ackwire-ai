import type { Message } from "@agenteschat/client";
import { useAiStatus, useAuthConfig, useMessages } from "@agenteschat/client";
import { withoutApiKeys } from "@agenteschat/client/lib/api-key-text";
import type { BillingHold } from "@agenteschat/client/lib/billing";
import { failedRunFix } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  aiStateOf,
  keptCardState,
  mayConnectAi,
  NO_AI,
  type NoAiCard as NoAiCardMeta,
  noAiCardOf,
  noAiLineKey,
  noAiStatusKey,
  opensByItself,
  planLineFix,
  planLinePasses,
  planOfKind,
  type RightHandPlanLine,
  signInAgainPlan,
} from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { Button, Chip, Dialog, DialogFooter, Icon, InfoHint } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { type ConnectAiRequest, useConnectAi } from "@/components/ConnectAi";
import { useOrg } from "@/components/org-context";
import { TeamTemplatesDialog } from "@/components/TeamPlan";
import { useDirectory } from "@/hooks/useDirectory";
import { usePaidReturn } from "@/lib/paid-return";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";
import { useChannelEvents } from "@/realtime/context";
import "./no-ai.css";

/*
 * No AI connected (ADR 0061), wherever it shows: above the composer, the agent's card in the
 * conversation, a "Sem IA" chip by its name, and the check before a message with an API key goes out.
 */

/**
 * Above the composer: this DM's agent has no AI, or (anywhere with agents) the organization has none, its ⓘ saying
 * it can also be asked for in the chat. Everyone sees it; the dialog says what each person may connect.
 */
export function NoAiBanner({ agentIds, dmAgentId }: { agentIds: string[]; dmAgentId?: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const held = usePlanHold() !== null;
  // On a billing hold an AI comes after the plan: the agent's card and the hold's banner say so.
  if (!status.data || !connect || held) return null;
  if (dmAgentId) {
    if (aiStateOf(status.data, dmAgentId) !== "no_ai") return null;
    const agent = dir.agentById.get(dmAgentId);
    const name = agent?.name ?? t("channel.unknownAgent");
    return (
      <div className="noai-banner" role="status">
        <span className="noai-banner__text ac-iconline">
          <Icon name="plug" size={16} />
          <b>{t(noAiStatusKey(status.data, dmAgentId), agentGrammar(name))}</b>
        </span>
        {mayConnectAi(agent, me.user.id, org) && (
          <Button size="sm" onClick={() => connect.open({ agentId: dmAgentId })}>
            {t("noAi.action")}
          </Button>
        )}
      </div>
    );
  }
  if (status.data.any || agentIds.length === 0) return null;
  const action = t("noAi.banner.orgAction");
  return (
    <div className="noai-banner" role="status">
      <span className="noai-banner__text ac-iconline">
        <Icon name="plug" size={16} />
        {/* Asking in the chat is understood only where Jev reads the message (`ai-intent.ts`). */}
        {status.data.routing?.by === "jev" ? (
          <span className="ac-hintline">
            <b>{t("noAi.banner.org")}</b>
            {/* Named by its topic, the button's: the line beside it is a whole sentence. */}
            <InfoHint name={t("common.about", { label: action })}>{t("noAi.banner.orgHint")}</InfoHint>
          </span>
        ) : (
          <b>{t("noAi.banner.org")}</b>
        )}
      </span>
      <Button size="sm" onClick={() => connect.open({ agentId: agentIds.length === 1 ? agentIds[0] : undefined })}>
        {action}
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
  const hold = usePlanHold();
  const card = noAiCardOf(message.meta);
  if (!card) return null;
  // Any card on a billing hold is the wall: a Connect or a key from before it leads nowhere until the plan.
  if (card.held || hold) return <KeptCard message={message} card={card} hold={hold} />;
  if (card.planLine)
    return <PlanLineCard message={message} agentId={card.agentId} line={card.planLine} model={card.model} />;
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const again = signInAgainPlan(card, agent);
  // The computer's own sign-in isn't there: Connect opens on an account of that CLI's plan.
  const plan = card.own ? planOfKind(card.own) : again;
  const answer = connect?.answered[message.id];
  const answering = answer === "answering";
  const state = aiStateOf(status.data, card.agentId);
  const ready = state !== undefined && state !== "no_ai" && answer !== "still_missing";
  // The same people as "Continuar": who asked, the agent's owner or an admin.
  const mayAnswer = card.forUserId === me.user.id || agent?.ownerUserId === me.user.id || can(org, "manage_agents");
  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  const title = answering
    ? t("noAi.card.answering", { name })
    : ready
      ? t("noAi.card.connected", { name })
      : answer === "still_missing"
        ? t("noAi.card.stillMissing", { name })
        : t(noAiLineKey(card), agentGrammar(name));
  const action =
    !connect || answering ? null : ready || answer === "pending" ? (
      mayAnswer && (
        <Button size="sm" variant="primary" loading={answer === "pending"} onClick={() => connect.answer(message.id)}>
          {t("noAi.card.answerNow")}
        </Button>
      )
    ) : !mayConnectAi(agent, me.user.id, org) ? (
      <span className="small muted">{owner ? t("noAi.locked", { name, owner }) : t("noAi.lockedAdmins")}</span>
    ) : (
      <Button
        size="sm"
        onClick={() =>
          connect.open({
            intent: card.intent,
            provider: card.provider,
            agentId: card.agentId,
            from: message.id,
            ...(plan ? { plan } : {}),
          })
        }
      >
        {t(again ? "agentPage.work.brain.signInAgain" : "noAi.action")}
      </Button>
    );
  return (
    <div className="waitcard" data-done={ready || answering || undefined}>
      <span className="waitcard__top ac-iconline">
        <Icon name={ready || answering ? "check" : "plug"} size={16} />
        <span>{title}</span>
      </span>
      {action && <span className="waitcard__acts">{action}</span>}
    </div>
  );
}

/**
 * The wall (ADR 0079 §6): an agent kept the person's message for after the plan. It follows the message from there
 * (`keptCardState`): the way to the plans, then Connect for the whole team, and once an AI is there, from wherever it
 * was connected, opening the conversation starts the answer with no click.
 */
function KeptCard({ message, card, hold }: { message: Message; card: NoAiCardMeta; hold: BillingHold | null }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const messages = useMessages(org.id, message.channelId).data;
  const billingUrl = useAuthConfig().data?.billingUrl;
  const paid = usePaidReturn(org.id, hold !== null);
  const [templates, setTemplates] = useState(false);
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const ai = aiStateOf(status.data, card.agentId);
  const state = keptCardState({ hold, paid, ready: ai !== undefined && ai !== "no_ai" });
  const answer = connect?.answered[message.id];
  const mayAnswer = card.forUserId === me.user.id || agent?.ownerUserId === me.user.id || can(org, "manage_agents");
  const replied = messages?.some(
    (m) => m.author.id === card.agentId && m.createdAt > message.createdAt && !noAiCardOf(m.meta),
  );
  const starts = state === "answer" && mayAnswer && replied === false && !answer && connect !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `connect` changes with each answer; once per card here
  useEffect(() => {
    if (!starts) return;
    const key = `${STORAGE_KEYS.noAiOpened}.answer.${message.id}`;
    if (sessionStore.get(key)) return;
    sessionStore.set(key, "1");
    void connect?.answer(message.id);
  }, [starts, message.id]);
  if (state === "answer") {
    return (
      <div className="waitcard" data-done>
        <span className="waitcard__top ac-iconline">
          <Icon name="check" size={16} />
          <span>{t(replied ? "noAi.card.connected" : "noAi.card.answering", { name })}</span>
        </span>
      </div>
    );
  }
  if (state === "connect") {
    return (
      <div className="waitcard">
        <span className="waitcard__top ac-iconline">
          <Icon name="plug" size={16} />
          <span>{t("noAi.kept.active", { name })}</span>
        </span>
        {connect && (
          <span className="waitcard__acts">
            {mayConnectAi(agent, me.user.id, org) ? (
              <Button size="sm" variant="primary" onClick={() => connect.open({ from: message.id })}>
                {t("noAi.action")}
              </Button>
            ) : (
              <span className="small muted">{t("noAi.lockedAdmins")}</span>
            )}
          </span>
        )}
      </div>
    );
  }
  const code = hold ?? "payment";
  const canPay = can(org, "manage_billing") && Boolean(billingUrl);
  // With no team yet, the way to one needs no model.
  const noTeam = isRightHand(agent) && can(org, "create_agents") && dir.agents.every(isRightHand);
  return (
    <div className="waitcard">
      <span className="waitcard__top ac-iconline">
        <Icon name="waiting" size={16} />
        <span>{t("noAi.kept.title")}</span>
      </span>
      <p>{code === "payment" ? t("noAi.kept.line") : t(`standing.billing.${code}`)}</p>
      {code === "payment" && <p>{t("noAi.kept.plan")}</p>}
      {state === "held" && (
        <span className="waitcard__acts">
          {canPay ? (
            <BillingLinkButton orgId={org.id} from="hold" size="sm" variant="primary">
              {t(`standing.billing.cta.${code}`)}
            </BillingLinkButton>
          ) : (
            <span className="small muted">{t("standing.billing.askAdmin")}</span>
          )}
          {noTeam && (
            <Button size="sm" onClick={() => setTemplates(true)}>
              {t("teamPlan.start.templates")}
            </Button>
          )}
        </span>
      )}
      {noTeam && <TeamTemplatesDialog open={templates} onClose={() => setTemplates(false)} />}
    </div>
  );
}

/**
 * The team's right hand on a plan that can't think now (ADR 0137 §7): one plain line saying why, with the way to an API
 * key. Once it can think again: "Responder agora".
 */
function PlanLineCard({
  message,
  agentId,
  line,
  model,
}: {
  message: Message;
  agentId: string;
  line: RightHandPlanLine;
  model?: string;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const ready = aiStateOf(status.data, agentId) === "ready" && planLinePasses(line);
  const fix = planLineFix(line, agent, me.user.id, org);
  return (
    <div className="waitcard" data-done={ready || undefined}>
      <span className="waitcard__top ac-iconline">
        <Icon name={ready ? "check" : "plug"} size={16} />
        <span>{ready ? t("noAi.card.connected", { name }) : t(`noAi.rightHand.${line}`, { name, model })}</span>
      </span>
      {connect && (
        <span className="waitcard__acts">
          {ready ? (
            <Button size="sm" variant="primary" onClick={() => connect.answer(message.id)}>
              {t("noAi.card.answerNow")}
            </Button>
          ) : // The workspace's plan serves only its owner: the person's own plan answers them (ADR 0137 §11).
          fix === "connectMine" ? (
            <Button size="sm" onClick={() => connect.open({ agentId, from: message.id })}>
              {t("rightHand.settings.connectMine")}
            </Button>
          ) : fix === "useKey" ? (
            <Button size="sm" onClick={() => connect.open({ agentId, intent: "api_key", from: message.id })}>
              {t("noAi.rightHand.useKey")}
            </Button>
          ) : (
            <span className="small muted">{t("noAi.lockedAdmins")}</span>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Beside a failed run's reason: the one thing that fixes it, for who can do it, a key (the Connect dialog) or another
 * model (its AI settings).
 */
export function FailedRunFix({ code, agentId }: { code: string | undefined; agentId: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const connect = useConnectAi();
  const held = usePlanHold() !== null;
  const fix = failedRunFix(code, {
    keys: can(org, "manage_credentials") && !held,
    admin: can(org, "manage_agents"),
    owner: dir.agentById.get(agentId)?.ownerUserId === me.user.id,
  });
  if (fix === "useKey" && connect)
    return (
      <Button size="sm" onClick={() => connect.open({ agentId, intent: "api_key" })}>
        {t("noAi.rightHand.useKey")}
      </Button>
    );
  if (fix !== "changeModel") return null;
  return (
    <Link
      to="/org/$orgId/agents/$agentId"
      params={{ orgId: org.id, agentId }}
      search={{ tab: "settings", sec: "brain" }}
      className="ac-btn ac-btn--sm"
    >
      {t("usageCard.changeModel")}
    </Link>
  );
}

/** "Sem IA" by an agent's name (its page, its profile card); it opens Connect. */
export function NoAiChip({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const held = usePlanHold() !== null;
  if (held || aiStateOf(status.data, agentId) !== "no_ai") return null;
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
  const held = usePlanHold() !== null;
  const admin = connect !== null && can(org, "manage_credentials") && !held;
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
