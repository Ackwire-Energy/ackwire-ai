import type { AgentDraft, AgentProposalCard, Message } from "@agenteschat/client";
import {
  useAiStatus,
  useChannels,
  useCreateProposedAgent,
  useCreateProposedRoutine,
  useDenyAgentProposal,
  useMailAccounts,
} from "@agenteschat/client";
import {
  actionCardOf,
  connectAiDone,
  type ProposalLine,
  proposalLines,
  proposalStatus,
  routineLeft,
  suggestedAiText,
} from "@agenteschat/client/lib/action-cards";
import { itemName } from "@agenteschat/client/lib/connected";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames, whenAt } from "@agenteschat/client/lib/format";
import { choiceOf } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Dialog, Icon, Spinner } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectedById } from "@/components/AccessLevels";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { CostlyProposalCardView } from "@/components/CostlyProposalCard";
import { MailIcon } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";
import { RequestCard, RequestDone, RequestFuse, useExpired } from "@/components/RequestCard";
import { StretchCardView } from "@/components/StretchCard";
import { UsagePauseCardView } from "@/components/UsagePauseCard";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { inPlaceClick } from "@/lib/navigate";
import { proposedRoutineWhen } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";
import { expiryText } from "@/pages/ApprovalsPage";

/** The whole time a proposal has (a day when its message doesn't say): the fuse burns down over it. */
const DAY_MS = 24 * 3_600_000;

/** "Criar agente" in the card's review, loaded when it opens. */
const NewAgentPage = lazy(() => import("@/pages/NewAgentPage").then((m) => ({ default: m.NewAgentPage })));

/**
 * An agent's action card (ADR 0061, `meta.actionCard`) in place of its text: what needs a person's
 * credentials or consent, one click away. "Conectar uma IA" opens the Connect dialog at the card's step for
 * the agents it names (the dialog says what each person may do), and is one line, "Conectado", once they can think.
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
  if (card.kind === "usage_paused") return <UsagePauseCardView message={message} card={card} />;
  if (card.kind === "autonomy_proposal") return <CostlyProposalCardView message={message} card={card} />;
  const done = connectAiDone(card, status.data, dir.agentById);
  const agents = joinNames(
    card.agentIds.map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent")),
    t,
  );
  const title = agents
    ? t("actionCard.connect_ai.title", { context: card.what, agents })
    : t(`connectAi.title.${card.what ?? "any"}`);
  if (done) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.connected")}: <b>{title}</b>
      </RequestDone>
    );
  }
  return (
    <div className="waitcard">
      <span className="waitcard__top ac-iconline">
        <Icon name="plug" size={16} />
        <span>{title}</span>
      </span>
      {card.why && <p>{card.why}</p>}
      {connect && (
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
      )}
    </div>
  );
}

/**
/**
 * "Ada propõe um novo agente". While it is open, a request card like every other: the agent's reason, the draft in the
 * well (its face, name, handle and role, and the AI it would think with where the line has room), what it gets a line
 * each, and the fuse to its expiry. Criar makes it as it is, in one click, with each line the person may give; Revisar
 * opens "Criar agente" filled in with it over the conversation; Recusar says no; all three for who may create agents.
 * Then one line says what was decided, the draft and what it got behind "Ver detalhes"; created, it links to the agent
 * there.
 */
function AgentProposalCardView({ message, card }: { message: Message; card: AgentProposalCard }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const create = useCreateProposedAgent(org.id);
  const makeRoutine = useCreateProposedRoutine(org.id);
  const connect = useConnectAi();
  const [reviewing, setReviewing] = useState(false);
  const deny = useDenyAgentProposal(org.id);
  const toast = useToast();
  const openPanel = useOpenAgentPanel();
  const { draft, why } = card.params;
  const status = proposalStatus(card);
  // Open until it expires: drawn again at that moment, even before the server's event says so.
  useExpired(status === "open" ? card.expiresAt : null);
  const decides = status === "open" && can(org, "create_agents");
  const agent = message.author.id ? dir.anyAgent(message.author.id) : undefined;
  const proposer = agent?.name || t("channel.unknownAgent");
  const title = t("actionCard.agentProposal.title", { agent: proposer });
  const lines = proposalLines(card, { userId: me.user.id, admin: can(org, "manage_agents") });
  const failed = (error: unknown) => toast.show(errorText(t, error), "error");
  const busy = create.isPending || deny.isPending;
  if (status === "open") {
    const end = Date.parse(card.expiresAt);
    const span = Math.max(1, end - Date.parse(message.createdAt) || DAY_MS);
    return (
      <>
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
          body={lines.length > 0 ? <ProposalLines lines={lines} draft={draft} /> : undefined}
          actions={
            decides ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  loading={create.isPending}
                  disabled={deny.isPending}
                  onClick={() =>
                    create.mutate(message.id, {
                      // Nothing to think with yet (the clicker's accounts decide, not the suggestion): it is
                      // created all the same, and Connect opens for it.
                      onSuccess: ({ agent: made, ai }) =>
                        ai === "none" && connect?.open({ agentId: made.id, agentIds: [made.id] }),
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
                  loading={deny.isPending}
                  disabled={create.isPending}
                  onClick={() => deny.mutate(message.id, { onError: failed })}
                >
                  {t("approval.refuse")}
                </Button>
              </>
            ) : undefined
          }
          end={<RequestFuse left={Math.max(0, end - Date.now()) / span} agent={agent} text={expiryText(t, card)} />}
          what={draft.name}
        />
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
      </>
    );
  }
  // Created, refused or expired: one line. No one decided one that ran out: it expired at its deadline.
  const ended =
    status === "created"
      ? t("actionCard.agentProposal.created")
      : t(status === "denied" ? "proposals.refused" : "approval.expired");
  const at = status === "expired" ? card.expiresAt : card.decidedAt;
  const details = (
    <>
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
      {status === "created" && (card.agentId || routineLeft(card)) && (
        <div className="ac-acts">
          {card.agentId && (
            <Button asChild size="sm" variant="ghost">
              {/* In a conversation, its page opens in the panel beside it. */}
              <Link
                to="/org/$orgId/agents/$agentId"
                params={{ orgId: org.id, agentId: card.agentId }}
                onClick={openPanel ? (e) => inPlaceClick(e, () => card.agentId && openPanel(card.agentId)) : undefined}
              >
                {t("newAgent.openProfile")}
              </Link>
            </Button>
          )}
          {routineLeft(card) && (card.decidedByUserId === me.user.id || can(org, "manage_routines")) && (
            // Not made with it (the agent wasn't where it reports yet): made from here once it is.
            <Button
              size="sm"
              variant="ghost"
              loading={makeRoutine.isPending}
              onClick={() => makeRoutine.mutate(message.id, { onError: failed })}
            >
              {t("newAgent.routineKeep", { name: draft.routine?.name })}
            </Button>
          )}
        </div>
      )}
    </>
  );
  return (
    <RequestDone done={status === "created"} label={title} more={{ label: t("approval.seeDetails"), content: details }}>
      {ended}: <b>{draft.name}</b>
      {at && ` · ${whenAt(t, i18n.language, at)}`}
    </RequestDone>
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
      text: routine ? [routine.name, proposedRoutineWhen(t, i18n.language, routine)].join(" · ") : l.id,
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
              {l.kind === "routine" && draft.routine && (
                <details className="waitcard__prompt">
                  <summary className="small muted">{t("routines.form.what")}</summary>
                  <p className="small">{draft.routine.prompt}</p>
                </details>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
