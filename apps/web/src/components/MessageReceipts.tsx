import type { DecidedBy, Message, SteerState } from "@agenteschat/client";
import { type ReceiptPhase, type ReceiptView, receiptView, useModelLabel, useSteerState } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { deciderOf } from "@agenteschat/client/lib/routing";
import { Icon, type IconName, InfoHint, PixelSpinner, Popover, ProviderLogo } from "@agenteschat/ui";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { useConnectAi } from "@/components/ConnectAi";
import { HelpLink } from "@/components/HelpLink";
import { useDirectory } from "@/hooks/useDirectory";
import { useLive } from "@/realtime/context";
import { CallAgentMenu, useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";

/** Which icon the receipt shows: one check (seen), two (answered), clock (answering/waiting), alert (failed). */
export function receiptIcon(view: ReceiptView): IconName {
  const kind = view.status?.kind;
  if (kind === "failed" || kind === "no_ai") return "alert";
  if (kind === "claimed" || kind === "waiting" || kind === "asking") return "waiting";
  if (kind === "handled") return "checks";
  return "check";
}

/** A rule's line leads with what it follows: the reply, the one person with the agent, the talk. */
const RULE_ICON: Record<Extract<DecidedBy, { step: "rule" }>["rule"], IconName> = {
  reply: "reply",
  only_agent: "person",
  follow_up: "thread",
};

/** A dot and the action after it: one piece, which wraps whole. */
function ReceiptAction({ children }: { children: ReactNode }) {
  return (
    <span className="ac-receipt__then">
      <span className="ac-receipt__dot" aria-hidden="true">
        ·
      </span>
      {children}
    </span>
  );
}

/**
 * What became of a message sent into a task at work: the reader's face once it read it, else the spinner while it
 * waits for the next pause, the bolt when it stopped to read, a check once handed over, the clock while an approval
 * holds it.
 */
function SteerMark({ steer, name, size }: { steer: SteerState; name: string; size: 14 | 16 }) {
  if (steer.state === "read" || steer.state === "resolved")
    return <AgentAvatar agentId={steer.agentId} name={name} size="xs" state="idle" />;
  if (steer.state === "waiting") return <PixelSpinner size={size} />;
  return <Icon name={steer.state === "now" ? "bolt" : steer.state === "delivered" ? "check" : "waiting"} size={size} />;
}

/**
 * A person's message's receipt: a small muted mark at the end of its first line (`part="check"`), never a line of its
 * own, so it never changes the message's height or the room before the next one. Clicking or focusing it opens a
 * popover with each agent and its status, and who picked them. A message sent into a task at work wears what became
 * of it there instead of the check ("Ada leu" is Ada's face), the words said to screen readers as they change. Words
 * only for what you can act on ("Nenhum agente vai responder", a failure, no AI connected), and while the author's own
 * plan picks: then the whole receipt is a line under the message (`part="line"`), so the text still follows the name.
 */
export function MessageReceipts({ message, part }: { message: Message; part: "check" | "line" }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const connect = useConnectAi();
  const modelLabel = useModelLabel();
  const steerId = useId();
  const receipt = useLive((s) => s.receipts[message.id]);
  const steer = useSteerState(org.id, message.channelId, part === "check" ? message.id : "");
  const steerName = steer ? dir.agentById.get(steer.agentId)?.name : undefined;
  const steered =
    steer && steerName ? { steer, name: steerName, text: t(`run.steer.${steer.state}`, { name: steerName }) } : null;
  const view = receiptView(receipt);
  const status = view.status;
  const callAgent =
    actions && actions.channelAgents.length > 0 ? (
      <ReceiptAction>
        <CallAgentMenu />
      </ReceiptAction>
    ) : null;
  const worded =
    view.picking === true ||
    status?.kind === "nobody" ||
    status?.kind === "no_ai" ||
    status?.kind === "platform_cap" ||
    (status?.kind === "failed" && actions !== null);
  // The mark stays where a line says the rest (a failure, nobody): what became of it in the task is its own news.
  if (part === "line" ? !worded : worded && !steered) return null;
  if (view.picking && part === "line") {
    return (
      <div className="ac-receipt">
        <span className="ac-receipt__clock">
          <Icon name="waiting" />
        </span>
        <span className="ac-receipt__words">
          <span>{t("receipts.picking")}</span>
          {callAgent}
        </span>
      </div>
    );
  }
  if (view.seen.length === 0 && !steered && status?.kind !== "no_ai" && status?.kind !== "platform_cap") return null;

  const name = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const names = (ids: string[]) => joinNames(ids.map(name), t("newAgent.and"));
  const mentionNeeded = status?.kind === "nobody" && status.mentionNeeded === true;
  const statusText =
    status === null
      ? ""
      : status.kind === "nobody"
        ? t(mentionNeeded ? "receipts.mentionNeeded" : "receipts.nobody")
        : status.kind === "no_ai"
          ? t("noAi.receipt")
          : status.kind === "platform_cap"
            ? t("receipts.platformCap")
            : t(`receipts.${status.kind}`, { count: status.agents.length, names: names(status.agents) });
  const label = [view.seen.length > 0 && t("receipts.seenBy", { names: names(view.seen) }), statusText]
    .filter(Boolean)
    .join(". ");
  const phases = new Map<string, ReceiptPhase>(receipt?.agents ?? []);
  const phaseText = (id: string) => {
    const phase = phases.get(id) ?? "seen";
    if (phase === "no_ai") return t("noAi.chip");
    return view.referenced.includes(id) && phase === "seen"
      ? t("receipts.status.referenced")
      : t(`receipts.status.${phase}`);
  };
  const by = deciderOf(t, view, {
    meId: me.user.id,
    agent: name,
    person: (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
    model: modelLabel,
  });

  const check = (view.seen.length > 0 || steered) && (
    <Popover
      label={t("receipts.popoverTitle")}
      trigger={
        <button
          type="button"
          className="ac-receipt__check"
          aria-label={label || steered?.text}
          aria-describedby={steered && label ? steerId : undefined}
          data-state-kind={steered ? undefined : (status?.kind ?? "seen")}
          data-steer={steered?.steer.state}
        >
          {steered ? (
            // Keyed by the state: each new mark swaps in.
            <SteerMark key={steered.steer.state} steer={steered.steer} name={steered.name} size={16} />
          ) : (
            <Icon name={receiptIcon(view)} />
          )}
        </button>
      }
    >
      <div className="ac-popover__title">{t("receipts.popoverTitle")}</div>
      {view.seen.map((id) => (
        <div key={id} className="ac-popover__row">
          <AgentAvatar agentId={id} size="xs" name={name(id)} />
          <span>{name(id)}</span>
          <span className="ac-popover__row-status">{phaseText(id)}</span>
        </div>
      ))}
      {steered && (
        <div className="who-by ac-iconline">
          <SteerMark steer={steered.steer} name={steered.name} size={14} />
          <span>{steered.text}</span>
        </div>
      )}
      {by && (
        <div className="who-by ac-iconline">
          {"logo" in by.mark ? (
            <ProviderLogo id={by.mark.logo} size="xs" />
          ) : (
            <Icon name={RULE_ICON[by.mark.rule]} size={14} />
          )}
          <span>{by.text}</span>
        </div>
      )}
      {mentionNeeded && (
        <div className="who-by">
          <HelpLink slug="who-answers">{t("routing.how")}</HelpLink>
        </div>
      )}
    </Popover>
  );

  if (part === "check") {
    return (
      <div className="ac-receipt">
        {check}
        {steered && (
          <span id={steerId} className="ac-visually-hidden" aria-live="polite">
            {steered.text}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="ac-receipt">
      {check}
      {status?.kind === "failed" && actions && (
        <span className="ac-receipt__words">
          <span>{t("receipts.failedShort")}</span>
          <ReceiptAction>
            <button type="button" className="ac-receipt__action" onClick={() => actions.resend(message.body)}>
              {t("receipts.retry")}
            </button>
          </ReceiptAction>
        </span>
      )}
      {status?.kind === "nobody" && (
        <span className="ac-receipt__words">
          {mentionNeeded ? (
            <span className="ac-hintline">
              <span>{t("receipts.mentionNeeded")}</span>
              <InfoHint name={t("common.about", { label: t("routing.title") })}>
                {t("receipts.mentionNeededHint")}
              </InfoHint>
            </span>
          ) : (
            <span>{t("receipts.nobody")}</span>
          )}
          {callAgent}
        </span>
      )}
      {status?.kind === "platform_cap" && (
        <span className="ac-receipt__words">
          <span>{t("receipts.platformCap")}</span>
        </span>
      )}
      {status?.kind === "no_ai" && (
        <span className="ac-receipt__words">
          <span>{t("noAi.receipt")}</span>
          {connect && (
            <ReceiptAction>
              <button
                type="button"
                className="ac-receipt__action"
                onClick={() =>
                  connect.open({
                    intent: receipt?.noAi?.intent,
                    provider: receipt?.noAi?.provider,
                    agentId: status.agents.length === 1 ? status.agents[0] : undefined,
                    from: message.id,
                  })
                }
              >
                {t("noAi.action")}
              </button>
            </ReceiptAction>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * "Visto" in a DM between people, in the receipt's place at the end of my latest message's first line: the face of
 * who read it. The words are said to screen readers as it shows, and on hover.
 */
export function SeenMark({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.memberById.get(personId)?.name ?? t("channel.unknownPerson");
  const words = t("receipts.seenBy", { names: name });
  return (
    <span className="ac-receipt__seen" title={words}>
      <ActorAvatar actor={{ type: "person", id: personId }} name={name} size="xs" />
      <span className="ac-visually-hidden" aria-live="polite">
        {words}
      </span>
    </span>
  );
}
