import type { AgentProposalCard, Message } from "@agenteschat/client";
import { useAiStatus, useDenyAgentProposal } from "@agenteschat/client";
import { actionCardOf, connectAiDone, proposalStatus, suggestedAiText } from "@agenteschat/client/lib/action-cards";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Chip, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useConnectAi } from "@/components/ConnectAi";
import { useOrg } from "@/components/org-context";
import { StretchCardView } from "@/components/StretchCard";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

/**
 * An agent's action card (ADR 0061, `meta.actionCard`) in place of its text: what needs a person's
 * credentials or consent, one click away. "Conectar uma IA" opens the Connect dialog at the card's step for
 * the agents it names (the dialog says what each person may do), and reads "Conectado" once they can think.
 * A proposal of a new agent (ADR 0081) is its own card, and so is a stretch's pause with Continuar (ADR 0089).
 */
export function ActionCard({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const card = actionCardOf(message.meta);
  if (!card) return null;
  if (card.kind === "agent_proposal") return <AgentProposalCardView message={message} card={card} />;
  if (card.kind === "stretch_paused") return <StretchCardView message={message} card={card} />;
  const done = connectAiDone(card, status.data, dir.agentById);
  const agents = joinNames(
    card.agentIds.map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent")),
    t("newAgent.and"),
  );
  const title = agents
    ? t("actionCard.connect_ai.title", { context: card.what, agents })
    : t(`connectAi.title.${card.what ?? "any"}`);
  return (
    <div className="waitcard" data-done={done || undefined}>
      <span className="waitcard__top ac-iconline">
        <Icon name={done ? "check" : "plug"} size={16} />
        <span>{title}</span>
      </span>
      {card.why && <p>{card.why}</p>}
      {done ? (
        <span className="waitcard__acts">
          <Chip icon="check" tone="done">
            {t("actionCard.connected")}
          </Chip>
        </span>
      ) : (
        connect && (
          <span className="waitcard__acts">
            <Button
              size="sm"
              onClick={() =>
                connect.open({
                  intent: card.what,
                  provider: card.provider,
                  agentIds: card.agentIds,
                  agentId: card.agentIds[0],
                })
              }
            >
              {t("actionCard.connect")}
            </Button>
          </span>
        )
      )}
    </div>
  );
}

/**
 * "Ada propõe um novo agente": the draft at a glance (its face, name, role and the AI it would think with).
 * Revisar opens "Criar agente" filled in with it, Recusar says no; both only for who may create agents, and
 * only until it expires. Created, it links to the agent.
 */
function AgentProposalCardView({ message, card }: { message: Message; card: AgentProposalCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const deny = useDenyAgentProposal(org.id);
  const toast = useToast();
  const { draft, why } = card.params;
  const status = proposalStatus(card);
  const decides = status === "open" && can(org, "create_agents");
  const proposer = (message.author.id && dir.agentById.get(message.author.id)?.name) || t("channel.unknownAgent");
  return (
    <div className="waitcard" data-done={status === "created" || undefined}>
      <span className="waitcard__top ac-iconline">
        <Icon name={status === "created" ? "check" : "agent"} size={16} />
        <span>{t("actionCard.agentProposal.title", { agent: proposer })}</span>
      </span>
      <span className="ac-faceline">
        <AgentAvatar name={draft.name} appearance={lookOf(draft)} size="md" />
        <span>
          <b className="ac-captop">{draft.name}</b>
          <span className="small muted">{[`@${draft.handle}`, draft.role].filter(Boolean).join(" · ")}</span>
        </span>
      </span>
      <span className="small muted ac-iconline">
        <Icon name="bolt" size={14} />
        <span>{suggestedAiText(t, draft.ai)}</span>
      </span>
      {why && <p>{why}</p>}
      <span className="waitcard__acts">
        {decides ? (
          <>
            <Button asChild size="sm" variant="primary">
              <Link to="/org/$orgId/agents/new" params={{ orgId: org.id }} search={{ proposal: message.id }}>
                {t("actionCard.agentProposal.review")}
              </Link>
            </Button>
            <Button
              size="sm"
              loading={deny.isPending}
              onClick={() => deny.mutate(message.id, { onError: (error) => toast.show(errorText(t, error), "error") })}
            >
              {t("approval.refuse")}
            </Button>
          </>
        ) : status === "created" ? (
          <>
            <Chip icon="check" tone="done">
              {t("actionCard.agentProposal.created")}
            </Chip>
            {card.agentId && (
              <Button asChild size="sm" variant="ghost">
                <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: card.agentId }}>
                  {t("newAgent.openProfile")}
                </Link>
              </Button>
            )}
          </>
        ) : status === "open" ? (
          <Chip icon="waiting" tone="waiting">
            {t("proposals.waitingAdmin")}
          </Chip>
        ) : (
          <Chip icon="close">{t(status === "denied" ? "proposals.refused" : "approval.expired")}</Chip>
        )}
      </span>
    </div>
  );
}
