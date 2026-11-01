import type { AgentDraft, AgentProposalCard, Message } from "@agenteschat/client";
import {
  useAiStatus,
  useChannels,
  useCreateProposedAgent,
  useDenyAgentProposal,
  useMailAccounts,
} from "@agenteschat/client";
import {
  actionCardOf,
  connectAiDone,
  type ProposalLine,
  proposalLines,
  proposalStatus,
  suggestedAiText,
} from "@agenteschat/client/lib/action-cards";
import { itemName } from "@agenteschat/client/lib/connected";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { choiceOf } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Chip, Dialog, Icon, Spinner } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectedById } from "@/components/AccessLevels";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { MailIcon } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";
import { StretchCardView } from "@/components/StretchCard";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { proposedRoutineWhen } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";

/** "Criar agente" in the card's review, loaded when it opens. */
const NewAgentPage = lazy(() => import("@/pages/NewAgentPage").then((m) => ({ default: m.NewAgentPage })));

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
 * "Ada propõe um novo agente": the draft at a glance (its face, name and role, why, what it gets and the AI it would
 * think with). Criar makes it as it is, in one click, with each line the person may give; Revisar opens "Criar agente"
 * filled in with it over the conversation; Recusar says no. All three only for who may create agents, and only until
 * it expires. Created, it links to the agent and says what it got.
 */
function AgentProposalCardView({ message, card }: { message: Message; card: AgentProposalCard }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const create = useCreateProposedAgent(org.id);
  const connect = useConnectAi();
  const [reviewing, setReviewing] = useState(false);
  const deny = useDenyAgentProposal(org.id);
  const toast = useToast();
  const { draft, why } = card.params;
  const status = proposalStatus(card);
  const decides = status === "open" && can(org, "create_agents");
  const proposer = (message.author.id && dir.agentById.get(message.author.id)?.name) || t("channel.unknownAgent");
  const lines = proposalLines(card, { userId: me.user.id, admin: can(org, "manage_agents") });
  const failed = (error: unknown) => toast.show(errorText(t, error), "error");
  const busy = create.isPending || deny.isPending;
  return (
    <div className="waitcard" data-done={status === "created" || undefined}>
      <span className="waitcard__top ac-iconline">
        <Icon name={status === "created" ? "check" : "agent"} size={16} />
        <span>{t("actionCard.agentProposal.title", { agent: proposer })}</span>
      </span>
      <span className="ac-faceline">
        <AgentAvatar name={draft.name} appearance={lookOf(draft)} size="md" />
        <span className="list-col">
          <b className="ac-captop">{draft.name}</b>{" "}
          <span className="small muted">{[`@${draft.handle}`, draft.role].filter(Boolean).join(" · ")}</span>
        </span>
      </span>
      {why && <p>{why}</p>}
      {lines.length > 0 && <ProposalLines lines={lines} draft={draft} />}
      <span className="small muted ac-iconline">
        <Icon name="bolt" size={14} />
        <span>{suggestedAiText(t, draft.ai)}</span>
      </span>
      <span className="waitcard__acts">
        {decides ? (
          <>
            <Button
              size="sm"
              variant="primary"
              loading={create.isPending}
              disabled={deny.isPending}
              onClick={() =>
                create.mutate(message.id, {
                  // Nothing to think with yet: it is created all the same, and Connect opens for it.
                  onSuccess: ({ agent }) =>
                    draft.ai.kind === "none" && connect?.open({ agentId: agent.id, agentIds: [agent.id] }),
                  onError: failed,
                })
              }
            >
              {t("newAgent.create", { name: draft.name })}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setReviewing(true)}>
              {t("actionCard.agentProposal.review")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={deny.isPending}
              disabled={create.isPending}
              onClick={() => deny.mutate(message.id, { onError: failed })}
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
      {reviewing && (
        // Over the conversation: creating, saying no or leaving closes it, and the person is where they were.
        <Dialog
          bare
          open
          onOpenChange={(open) => !open && setReviewing(false)}
          title={t("actionCard.agentProposal.reviewTitle", { name: draft.name })}
          closeLabel={t("common.close")}
          width={1200}
          className="newag-dialog"
        >
          <Suspense fallback={<Spinner />}>
            <NewAgentPage proposalId={message.id} onClose={() => setReviewing(false)} />
          </Suspense>
        </Dialog>
      )}
    </div>
  );
}

/**
 * What the proposed agent gets, a line each: its channels, its apps and mailboxes at their level, its routine. A line
 * the viewer can't give says who gives it; created in one click, the lines it got take a check.
 */
function ProposalLines({ lines, draft }: { lines: ProposalLine[]; draft: AgentDraft }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const apps = useConnectedById();
  const mail = useMailAccounts(org.id);
  const says = (level: "read" | "write" | undefined, name: string) =>
    t(level === "write" ? "newAgent.preview.readsWrites" : "newAgent.preview.reads", { name });
  const shown = (l: ProposalLine): { icon: ReactNode; text: string } => {
    if (l.kind === "channel") {
      const name = channels.data?.find((c) => c.id === l.id)?.name;
      return {
        icon: <Icon name="channel" size={14} />,
        text: name ?? t("actionCard.agentProposal.aChannel"),
      };
    }
    if (l.kind === "app") {
      const item = apps.get(l.id);
      const name = item ? itemName(t, item) : t("actionCard.agentProposal.anApp");
      return {
        icon: item ? <ConnectorIcon def={item.def} image={item.image} label={name} /> : <Icon name="plug" size={14} />,
        text: says(l.level, name),
      };
    }
    if (l.kind === "mail") {
      const box = draft.mail?.find((m) => m.accountId === l.id);
      const account = mail.data?.find((a) => a.id === l.id);
      return {
        icon: account ? <MailIcon choice={choiceOf(account)} /> : <Icon name="mail" size={14} />,
        text: says(l.level, box?.address ?? ""),
      };
    }
    const routine = draft.routine;
    return {
      icon: <Icon name="routines" size={14} />,
      text: routine ? `${routine.name} · ${proposedRoutineWhen(t, i18n.language, routine)}` : l.id,
    };
  };
  const needs = (l: ProposalLine) =>
    !l.needs
      ? null
      : l.needs.who === "admin"
        ? t("actionCard.agentProposal.needsAdmin")
        : t("actionCard.agentProposal.needsPerson", {
            name: dir.memberById.get(l.needs.userId)?.name ?? t("actionCard.agentProposal.itsOwner"),
          });
  return (
    <ul className="waitcard__lines" aria-label={t("actionCard.agentProposal.lines", { name: draft.name })}>
      {lines.map((l) => {
        const { icon, text } = shown(l);
        const who = needs(l);
        return (
          <li key={l.key} className="ac-iconline" data-given={l.given ?? undefined}>
            {l.given ? <Icon name="check" size={14} /> : icon}
            <span>
              {text}
              {who && <span className="waitcard__needs"> · {who}</span>}
              {l.kind === "routine" && l.given === false && (
                <span className="waitcard__needs"> · {t("actionCard.agentProposal.routineNotMade")}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
