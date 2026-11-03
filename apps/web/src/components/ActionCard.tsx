import type { AgentDraft, AgentProposalCard, Message, SkillSourceUpdate } from "@agenteschat/client";
import {
  useAiStatus,
  useAllInvitations,
  useCatalog,
  useChannels,
  useConnections,
  useCreateProposedAgent,
  useCreateProposedRoutine,
  useCustomServers,
  useDenyAgentProposal,
  useMailAccounts,
  useMembers,
  useSkillAction,
  useSkills,
  useSkillUsage,
} from "@agenteschat/client";
import {
  actionCardOf,
  type ConnectAppCard,
  connectAiDone,
  connectAppDone,
  type InstallSkillCard,
  type InviteCard,
  installSkillDone,
  inviteDone,
  type ProposalLine,
  proposalLines,
  proposalStatus,
  routineLeft,
  skillUpdateState,
  suggestedAiText,
  type UpdateSkillsCard,
} from "@agenteschat/client/lib/action-cards";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames, whenAt } from "@agenteschat/client/lib/format";
import { hostOf } from "@agenteschat/client/lib/import/shared";
import { choiceOf } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { SKILL_UPDATE_TOAST } from "@agenteschat/client/lib/skills";
import { Button, Dialog, Icon, Spinner } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectedById } from "@/components/AccessLevels";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { CostlyProposalCardView } from "@/components/CostlyProposalCard";
import { useInviteDialog } from "@/components/invite/InviteDialog";
import { MailIcon } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";
import { RequestCard, RequestDone, RequestFuse, useExpired } from "@/components/RequestCard";
import { InstallSkillDialog, SkillSheet } from "@/components/Skills";
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
  if (card.kind === "connect_app") return <ConnectAppCardView card={card} />;
  if (card.kind === "invite_people") return <InviteCardView card={card} />;
  if (card.kind === "install_skill") return <InstallSkillCardView card={card} />;
  if (card.kind === "update_skills") return <UpdateSkillsCardView message={message} card={card} />;
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
 * "Conectar Linear" / "Adicionar MCP" (`offer_connect_app`): Conectar opens the same connect dialog as Settings, at the
 * catalog entry or at connecting by address with the address filled in; the person signs in or types the key there.
 * Who may not connect reads who does. Done once the workspace has it.
 */
function ConnectAppCardView({ card }: { card: ConnectAppCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const servers = useCustomServers(org.id);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const defs = catalog.data?.connectors ?? [];
  const def = defs.find((d) => d.id === card.connector) ?? null;
  const name = def ? connectorName(t, def) : card.url ? hostOf(card.url) : "";
  const title = name ? t("actionCard.connect_app.title", { name }) : t("actionCard.connect_app.mcp");
  if (connectAppDone(card, connectedItems(connections.data ?? [], servers.data ?? [], defs))) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.connected")}: <b>{title}</b>
      </RequestDone>
    );
  }
  return (
    <div className="waitcard">
      <span className="waitcard__top ac-iconline">
        {def ? <ConnectorIcon def={def} label={name} /> : <Icon name="plug" size={16} />}
        <span>{title}</span>
      </span>
      {card.why && <p>{card.why}</p>}
      {card.url && (
        <p className="small">
          <code>{card.url}</code>
        </p>
      )}
      <span className="waitcard__acts">
        {can(org, "manage_connectors") ? (
          <Button size="sm" onClick={() => setFlow(def ? { step: 0, def } : { step: 0, def: null, url: card.url })}>
            {t("actionCard.connect")}
          </Button>
        ) : (
          <span className="small muted">{t("actionCard.connect_app.adminOnly")}</span>
        )}
      </span>
      <ConnectFlow flow={flow} onChange={setFlow} onClose={() => setFlow(null)} />
    </div>
  );
}

/**
 * "Instalar uma skill" (`offer_install_skill`): Instalar opens Instalar skill with the link read, its skills listed to
 * pick; who manages agents installs there. Done once the library has a skill from that link.
 */
function InstallSkillCardView({ card }: { card: InstallSkillCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const may = can(org, "manage_agents");
  const skills = useSkills(org.id, may);
  const [open, setOpen] = useState(false);
  const title = t("actionCard.install_skill.title");
  if (installSkillDone(card, skills.data ?? [])) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.install_skill.done")}: <b>{card.url}</b>
      </RequestDone>
    );
  }
  return (
    <div className="waitcard">
      <span className="waitcard__top ac-iconline">
        <Icon name="book" size={16} />
        <span>{title}</span>
      </span>
      {card.why && <p>{card.why}</p>}
      <p className="small">
        <code>{card.url}</code>
      </p>
      <span className="waitcard__acts">
        {may ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            {t("actionCard.install_skill.open")}
          </Button>
        ) : (
          <span className="small muted">{t("actionCard.install_skill.adminOnly")}</span>
        )}
      </span>
      {may && (
        <InstallSkillDialog
          open={open}
          onOpenChange={setOpen}
          onInstalled={() => {}}
          initialUrl={open ? card.url : undefined}
        />
      )}
    </div>
  );
}

/**
 * "Atualizar skills" (`update_skill_from_source`): each skill with where it stands. Atualizar reads its link (new text
 * applies, files that run wait); Revisar opens the skill, where its waiting update is applied or refused. Done once
 * every one was read after the card and nothing waits.
 */
function UpdateSkillsCardView({ message, card }: { message: Message; card: UpdateSkillsCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const may = can(org, "manage_agents");
  const skills = useSkills(org.id, true);
  const action = useSkillAction(org.id);
  const [open, setOpen] = useState<string | null>(null);
  const usage = useSkillUsage(org.id, open !== null);
  const rows = card.skillIds.map((id) => {
    const skill = skills.data?.find((s) => s.id === id);
    return { id, name: skill?.name ?? "", state: skillUpdateState(skill, message.createdAt) };
  });
  const title = t("actionCard.update_skills.title", { count: rows.length });
  if (skills.data && rows.every((r) => r.state === "done")) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.update_skills.done")}:{" "}
        <b>
          {rows
            .map((r) => r.name)
            .filter(Boolean)
            .join(", ")}
        </b>
      </RequestDone>
    );
  }
  return (
    <div className="waitcard">
      <span className="waitcard__top ac-iconline">
        <Icon name="book" size={16} />
        <span>{title}</span>
      </span>
      {card.why && <p>{card.why}</p>}
      <ul className="stack-2">
        {rows
          .filter((r) => r.name)
          .map((r) => (
            <li key={r.id} className="row" style={{ gap: 8, alignItems: "center" }}>
              <b>{r.name}</b>
              {r.state === "done" ? (
                <span className="small muted">{t("actionCard.update_skills.done")}</span>
              ) : !may ? (
                r.state === "waiting" && <span className="small muted">{t("actionCard.update_skills.waiting")}</span>
              ) : r.state === "waiting" ? (
                <Button size="sm" onClick={() => setOpen(r.id)}>
                  {t("actionCard.update_skills.review")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(
                      { type: "updateFromSource", id: r.id },
                      {
                        onSuccess: (u) =>
                          toast.show(t(SKILL_UPDATE_TOAST[(u as SkillSourceUpdate).status], { name: r.name })),
                      },
                    )
                  }
                >
                  {t("actionCard.update_skills.update")}
                </Button>
              )}
            </li>
          ))}
      </ul>
      {!may && <span className="small muted">{t("actionCard.update_skills.adminOnly")}</span>}
      {open && <SkillSheet id={open} users={usage.get(open) ?? []} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * "Convidar pessoas" (`offer_invites`): Convidar opens the workspace's invite dialog with the addresses filled in, as
 * members; the person sends it there. Done once each address is invited or a member.
 */
function InviteCardView({ card }: { card: InviteCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const invite = useInviteDialog();
  const mayInvite = can(org, "invite_people");
  const invitations = useAllInvitations(org.id, mayInvite);
  const members = useMembers(org.id);
  const title = t("actionCard.invite.title", { count: card.emails.length });
  const known = [
    ...(invitations.data ?? []).filter((i) => i.status === "pending").map((i) => i.email),
    ...(members.data ?? []).map((m) => m.email),
  ];
  if (inviteDone(card, known)) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.invite.done")}: <b>{card.emails.join(", ")}</b>
      </RequestDone>
    );
  }
  return (
    <div className="waitcard">
      <span className="waitcard__top ac-iconline">
        <Icon name="personAdd" size={16} />
        <span>{title}</span>
      </span>
      {card.why && <p>{card.why}</p>}
      <p className="small muted">{card.emails.join(", ")}</p>
      <span className="waitcard__acts">
        {mayInvite && invite ? (
          <Button size="sm" onClick={() => invite.open({ emails: card.emails })}>
            {t("actionCard.invite.open")}
          </Button>
        ) : (
          <span className="small muted">{t("actionCard.invite.adminOnly")}</span>
        )}
      </span>
    </div>
  );
}

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
