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
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { useConnectAi } from "@/components/ConnectAi";
import { useOrg } from "@/components/org-context";
import { RequestCard, RequestFuse, useExpired } from "@/components/RequestCard";
import { StretchCardView } from "@/components/StretchCard";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { panelClick } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import { expiryText } from "@/pages/ApprovalsPage";

/** The whole time a proposal has (a day when its message doesn't say): the fuse burns down over it. */
const DAY_MS = 24 * 3_600_000;

/**
 * An agent's action card (ADR 0061, `meta.actionCard`) in place of its text: what needs a person's
 * credentials or consent, one click away. "Conectar uma IA" opens the Connect dialog at the card's step for
 * the agents it names (the dialog says what each person may do), and reads "Conectado" once they can think.
 * A proposal of a new agent (ADR 0081) is a request while it is open (`AgentProposalCardView`); a stretch's pause with
 * Continuar (ADR 0089) is its own card.
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
 * "Ada propõe um novo agente". While it is open, a request card like every other: the agent's reason, the draft
 * in the well (its face, name, handle and role, and the AI it would think with where the line has room), Revisar
 * (opens "Criar agente" filled in with it) and Recusar for who may create agents, and the fuse to its expiry.
 * Then what was decided; created, it links to the agent.
 */
function AgentProposalCardView({ message, card }: { message: Message; card: AgentProposalCard }) {
  const openPanel = useOpenAgentPanel();
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const deny = useDenyAgentProposal(org.id);
  const toast = useToast();
  const { draft, why } = card.params;
  const status = proposalStatus(card);
  // Open until it expires: drawn again at that moment, even before the server's event says so.
  useExpired(status === "open" ? card.expiresAt : null);
  const decides = status === "open" && can(org, "create_agents");
  const agent = message.author.id ? dir.anyAgent(message.author.id) : undefined;
  const proposer = agent?.name || t("channel.unknownAgent");
  const title = t("actionCard.agentProposal.title", { agent: proposer });
  if (status === "open") {
    const end = Date.parse(card.expiresAt);
    const span = Math.max(1, end - Date.parse(message.createdAt) || DAY_MS);
    const refuse = () => deny.mutate(message.id, { onError: (error) => toast.show(errorText(t, error), "error") });
    return (
      <RequestCard
        id={message.id}
        kind="agent"
        agent={agent}
        label={title}
        mine={decides}
        waitingFor={t("proposals.waitingAdmin")}
        lead={why || title}
        object={{
          logo: <AgentAvatar name={draft.name} appearance={lookOf(draft)} size="md" />,
          title: draft.name,
          // The AI comes last: where the line runs out, it is what gives way.
          detail: [`@${draft.handle}`, draft.role, suggestedAiText(t, draft.ai)].filter(Boolean).join(" · "),
        }}
        actions={
          decides ? (
            <>
              <Button asChild size="sm" variant="primary">
                <Link to="/org/$orgId/agents/new" params={{ orgId: org.id }} search={{ proposal: message.id }}>
                  {t("actionCard.agentProposal.review")}
                </Link>
              </Button>
              <Button size="sm" loading={deny.isPending} onClick={refuse}>
                {t("approval.refuse")}
              </Button>
            </>
          ) : undefined
        }
        end={<RequestFuse left={Math.max(0, end - Date.now()) / span} agent={agent} text={expiryText(t, card)} />}
        what={draft.name}
      />
    );
  }
  // Created, refused or expired: what was decided.
  return (
    <div className="waitcard" data-done={status === "created" || undefined}>
      <span className="waitcard__top ac-iconline">
        <Icon name={status === "created" ? "check" : "agent"} size={16} />
        <span>{title}</span>
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
        {status === "created" ? (
          <>
            <Chip icon="check" tone="done">
              {t("actionCard.agentProposal.created")}
            </Chip>
            {card.agentId && (
              <Button asChild size="sm" variant="ghost">
                <Link
                  to="/org/$orgId/agents/$agentId"
                  params={{ orgId: org.id, agentId: card.agentId }}
                  onClick={(e) => {
                    const id = card.agentId;
                    if (openPanel && id) panelClick(e, () => openPanel(id));
                  }}
                >
                  {t("newAgent.openProfile")}
                </Link>
              </Button>
            )}
          </>
        ) : (
          <Chip icon="close">{t(status === "denied" ? "proposals.refused" : "approval.expired")}</Chip>
        )}
      </span>
    </div>
  );
}
