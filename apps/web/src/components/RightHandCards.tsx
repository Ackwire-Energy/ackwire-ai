import type { AppNotification, Message, Proposal } from "@agenteschat/client";
import {
  CardVia,
  keys,
  useAgentActions,
  useAgentProposal,
  useApproval,
  useApprovals,
  useAskProposal,
  useAuthConfig,
  useCardProposals,
  useChangeRole,
  useChannels,
  useDecideProposal,
  useDecideProposals,
  useMembers,
  useModelLabel,
  useRoles,
  useSendDm,
  useSetMemberRoles,
} from "@agenteschat/client";
import {
  type ApprovalsCard,
  type MemberChangeRow,
  type MemberChangesCard,
  memberRowDone,
  type OpenPageCard,
  rolesAfter,
  type SettingsProposalCard,
} from "@agenteschat/client/lib/action-cards";
import { APP_PAGES, appPagePath } from "@agenteschat/client/lib/app-pages";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatTime, lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import {
  cardOutcome,
  chosenRows,
  decidersOf,
  isOpen,
  onlyKey,
  removalOf,
  rowStatus,
  sentToText,
  settingLineText,
} from "@agenteschat/client/lib/proposals";
import { Button, Icon, Switch } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentProposalCardView } from "@/components/ActionCard";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { ApprovalAsk } from "@/components/ApprovalAsk";
import { InlineApproval } from "@/components/ApprovalItem";
import { DeleteAgentsDialog } from "@/components/DeleteAgentDialog";
import { useOrg } from "@/components/org-context";
import { RemoveMemberDialog } from "@/components/RemoveMember";
import { RequestCard, RequestDone } from "@/components/RequestCard";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { SETTINGS_SECTIONS } from "@/pages/settings-sections";
import "./proposals.css";

/**
 * The right hand's card of a teammate's settings (ADR 0137): a request per row (one agent, one decider), each applied
 * as whoever clicks.
 */
export function SettingsProposalCardView({ message, card }: { message: Message; card: SettingsProposalCard }) {
  const { org } = useOrg();
  const rows = useCardProposals(org.id, card.proposalIds);
  const removal = removalOf(rows);
  if (removal) return <RemovalCard rows={rows} message={message} removal={removal} />;
  return (
    <>
      {rows.map((p) => (
        <SettingsRow key={p.id} p={p} message={message} />
      ))}
    </>
  );
}

/**
 * "Arquivar 5 agentes?" (`propose_remove_agents`): the agents listed, each with its switch, and "Arquivar todos" or
 * "Arquivar 3" for whoever may archive (or delete) them, applied as them row by row; the person who asked and can't,
 * Pedir a um admin. Decided, how it ended and Desfazer for what was archived (a deleted agent doesn't come back).
 */
function RemovalCard({
  rows,
  message,
  removal,
}: {
  rows: Proposal[];
  message?: Message;
  removal: "archive" | "delete";
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const members = useMembers(org.id).data ?? [];
  const roles = useRoles(org.id).data?.roles ?? [];
  const decide = useDecideProposals(org.id);
  const ask = useAskProposal(org.id);
  const actions = useAgentActions(org.id, message?.channelId ?? "");
  const toast = useToast();
  const qc = useQueryClient();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [first] = rows;
  if (!first) return null;
  const del = removal === "delete";
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const nameOf = (p: Proposal) => dir.anyAgent(p.agentId)?.name ?? t("channel.unknownAgent");
  const label = t(del ? "rightHand.remove.deleteTitle" : "rightHand.remove.archiveTitle", { count: rows.length });
  const open = rows.filter(isOpen);
  const { chosen, all } = chosenRows(rows, off);
  const decides = open.some((p) => p.canDecide);
  const mine = first.requestedBy?.userId === me.user.id;
  const toggle = (id: string, on: boolean) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  const run = (decision: "accept" | "refuse") =>
    decide.mutate(
      { ids: chosen.map((p) => p.id), decision },
      {
        onSuccess: ({ failed: f }) => f[0] && failed(f[0].error),
        onSettled: () => setConfirming(false),
      },
    );

  if (open.length === 0) {
    const outcome = cardOutcome(t, rows);
    const receipts = (message?.actions ?? []).filter((a) => rows.some((p) => p.undoActionId === a.id));
    const undoable = receipts.some((a) => !a.undoneAt && a.undoableUntil && Date.parse(a.undoableUntil) > Date.now());
    const undone = receipts.length > 0 && receipts.every((a) => a.undoneAt);
    const done = rows.filter((p) => p.status === "accepted");
    // One person decided every row the same way: "Aplicado por você", as on a settings row.
    const by = first.decidedBy;
    const alike = rows.every((p) => p.status === first.status && p.decidedBy?.userId === by?.userId);
    const byMe = by?.userId === me.user.id;
    const who =
      !alike || !by
        ? outcome.label
        : first.status === "accepted"
          ? byMe
            ? t("rightHand.card.appliedByYou")
            : t("rightHand.card.appliedBy", { name: by.name })
          : byMe
            ? t("rightHand.card.declinedByYou")
            : t("rightHand.card.declinedBy", { name: by.name });
    return (
      <RequestDone
        done={outcome.accepted && !undone}
        label={label}
        action={
          undoable && (
            <Button
              size="sm"
              variant="ghost"
              loading={actions.undoAll.isPending}
              onClick={() =>
                message &&
                actions.undoAll.mutate(message.id, {
                  onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(org.id) }),
                  onError: failed,
                })
              }
            >
              {t("rightHand.card.undo")}
            </Button>
          )
        }
      >
        {who}: <b>{(done.length ? done : rows).map(nameOf).join(", ")}</b>
        {first.decidedAt && ` · ${formatTime(i18n.language, first.decidedAt)}`}
        {undone && ` · ${t("rightHand.card.undone")}`}
      </RequestDone>
    );
  }

  const unsent = open.filter((p) => !p.canDecide && !p.askedAt);
  const sent = open.find((p) => p.askedAt);
  const state = decides ? undefined : mine && unsent.length > 0 ? t(onlyKey(first)) : t("proposals.waitingAdmin");
  const decision = decides ? (
    <>
      <Button
        size="sm"
        variant={del ? "danger" : "primary"}
        disabled={decide.isPending || chosen.length === 0}
        loading={decide.isPending && decide.variables?.decision === "accept"}
        onClick={() => (del ? setConfirming(true) : run("accept"))}
      >
        {all
          ? t(del ? "rightHand.remove.deleteAll" : "rightHand.remove.archiveAll")
          : t(del ? "rightHand.remove.deleteSome" : "rightHand.remove.archiveSome", { count: chosen.length })}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={decide.isPending || chosen.length === 0}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onClick={() => run("refuse")}
      >
        {t(mine ? "rightHand.card.dismiss" : "rightHand.card.decline")}
      </Button>
    </>
  ) : mine && unsent.length > 0 ? (
    <Button
      size="sm"
      variant="primary"
      icon="arrowUp"
      loading={ask.isPending}
      onClick={async () => {
        try {
          for (const p of unsent) await ask.mutateAsync(p.id);
        } catch (e) {
          failed(e);
        }
      }}
    >
      {t("rightHand.card.askAdmin")}
    </Button>
  ) : (
    sent?.askedAt && (
      <span className="rq__sent ac-iconline">
        <Icon name="arrowUp" size={14} />
        <span>{sentToText(t, i18n.language, decidersOf(sent, members, roles, null), sent.askedAt)}</span>
      </span>
    )
  );
  return (
    <>
      <DeleteAgentsDialog
        key={String(confirming)}
        names={confirming ? chosen.map(nameOf) : null}
        pending={decide.isPending}
        onConfirm={() => run("accept")}
        onClose={() => setConfirming(false)}
      />
      <RequestCard
        id={first.id}
        kind="proposal"
        agent={dir.anyAgent(first.proposedByAgentId ?? first.agentId)}
        label={label}
        mine={decides}
        waitingFor={state}
        lead={del ? `${first.why} ${t("rightHand.remove.deleteHelp")}` : first.why}
        body={
          <ul className="proposal-rows">
            {rows.map((p) => {
              const agent = dir.anyAgent(p.agentId);
              const name = nameOf(p);
              const status = rowStatus(t, p);
              return (
                <li key={p.id} className="proposal-row">
                  <AgentAvatar agentId={p.agentId} size="sm" name={name} />
                  <span className="proposal-row__what">
                    <span className="proposal-row__name">{name}</span>
                    {agent && <span>{[`@${agent.handle}`, agent.role].filter(Boolean).join(" · ")}</span>}
                  </span>
                  {status && <span className="proposal-row__status">{status}</span>}
                  {isOpen(p) && p.canDecide && (
                    <Switch
                      checked={!off.has(p.id)}
                      disabled={decide.isPending}
                      onCheckedChange={(on) => toggle(p.id, on)}
                      aria-label={t("proposals.include", { name })}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        }
        actions={decision || undefined}
        what={label}
      />
    </>
  );
}

/**
 * One row: "Propõe uma mudança", the agent in the well, "Modelo: Haiku → Sonnet" a line each, and the decision.
 * Who may decide it gets Aplicar and Descartar (Recusar in the inbox); the person who asked and can't, Pedir a um
 * admin, then whom it went to. Decided, one line with who did it, and Desfazer on its receipt while it lasts.
 */
function SettingsRow({ p, message }: { p: Proposal; message?: Message }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const modelLabel = useModelLabel();
  const members = useMembers(org.id).data ?? [];
  const channels = useChannels(org.id).data ?? [];
  const roles = useRoles(org.id).data?.roles ?? [];
  const decide = useDecideProposal(org.id);
  const ask = useAskProposal(org.id);
  const redo = useSendDm(org.id);
  const actions = useAgentActions(org.id, message?.channelId ?? "");
  const toast = useToast();
  const qc = useQueryClient();
  const agent = dir.anyAgent(p.agentId);
  const proposer = dir.anyAgent(p.proposedByAgentId ?? p.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const lines = (p.settings ?? []).map((l) =>
    settingLineText(t, i18n.language, l, {
      model: (id) => modelLabel(id) ?? id,
      person: (id) => dir.memberById.get(id)?.name,
      channel: (id) => channels.find((c) => c.id === id)?.name,
      role: dir.roleName,
    }),
  );
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const mine = p.requestedBy?.userId === me.user.id;
  const label = t("proposals.titleSettings", g);

  if (p.status !== "pending") {
    const receipt = message?.actions?.find((a) => a.id === p.undoActionId);
    const byMe = p.decidedBy?.userId === me.user.id;
    const who =
      p.status === "accepted"
        ? byMe
          ? t("rightHand.card.appliedByYou")
          : t("rightHand.card.appliedBy", { name: p.decidedBy?.name ?? "" })
        : byMe
          ? t("rightHand.card.declinedByYou")
          : t("rightHand.card.declinedBy", { name: p.decidedBy?.name ?? "" });
    const undoable =
      receipt && !receipt.undoneAt && receipt.undoableUntil && Date.parse(receipt.undoableUntil) > Date.now();
    return (
      <RequestDone
        done={p.status === "accepted" && !receipt?.undoneAt}
        label={label}
        action={
          undoable && (
            <Button
              size="sm"
              variant="ghost"
              loading={actions.undo.isPending}
              onClick={() =>
                actions.undo.mutate(receipt.id, {
                  onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(org.id) }),
                  onError: failed,
                })
              }
            >
              {t("rightHand.card.undo")}
            </Button>
          )
        }
      >
        {who}: <b>{[name, ...lines.map((l) => `${lowerFirst(l.field, i18n.language)} ${l.to}`)].join(" · ")}</b>
        {p.decidedAt && ` · ${formatTime(i18n.language, p.decidedAt)}`}
        {receipt?.undoneAt && ` · ${t("rightHand.card.undone")}`}
      </RequestDone>
    );
  }

  const asked = p.askedAt
    ? sentToText(t, i18n.language, decidersOf(p, members, roles, agent?.ownerUserId), p.askedAt)
    : null;
  const state = p.stale
    ? t("rightHand.card.stale")
    : p.canDecide
      ? undefined
      : p.askedAt
        ? t("proposals.waitingAdmin")
        : mine
          ? t(onlyKey(p), g)
          : t("proposals.waitingAdmin");
  const decision = p.stale ? (
    mine &&
    proposer && (
      <Button
        size="sm"
        variant="primary"
        icon="refresh"
        loading={redo.isPending}
        onClick={() =>
          redo.mutate({ agentId: proposer.id, body: t("rightHand.card.redoMessage", g) }, { onError: failed })
        }
      >
        {t("rightHand.card.redo")}
      </Button>
    )
  ) : p.canDecide ? (
    <>
      <Button
        size="sm"
        variant="primary"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "accept"}
        onClick={() => decide.mutate({ id: p.id, decision: "accept" }, { onError: failed })}
      >
        {t("rightHand.card.apply")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onClick={() => decide.mutate({ id: p.id, decision: "refuse" }, { onError: failed })}
      >
        {t(mine ? "rightHand.card.dismiss" : "rightHand.card.decline")}
      </Button>
    </>
  ) : asked ? (
    <span className="rq__sent ac-iconline">
      <Icon name="arrowUp" size={14} />
      <span>{asked}</span>
    </span>
  ) : (
    mine && (
      <Button
        size="sm"
        variant="primary"
        icon="arrowUp"
        loading={ask.isPending}
        onClick={() => ask.mutate(p.id, { onError: failed })}
      >
        {t("rightHand.card.askAdmin")}
      </Button>
    )
  );
  return (
    <RequestCard
      id={p.id}
      kind="proposal"
      agent={proposer}
      label={label}
      mine={p.canDecide && !p.stale}
      waitingFor={state}
      lead={p.stale ? t("rightHand.card.staleHelp", g) : p.why}
      object={{
        logo: <AgentAvatar agentId={p.agentId} name={name} size="md" />,
        title: t("rightHand.card.settings", { name }),
        detail: [agent?.handle ? `@${agent.handle}` : null, agent?.role].filter(Boolean).join(" · "),
      }}
      body={
        lines.length > 0 && (
          <dl className="rq__settings">
            {lines.map((l) => (
              <div key={`${l.field}:${l.to}`} className="rq__setting">
                <dt>{l.field}</dt>
                <dd>
                  <s>{l.from}</s>
                  <Icon name="arrowRight" size={14} label={t("rightHand.card.to")} />
                  <b>{l.to}</b>
                </dd>
              </div>
            ))}
          </dl>
        )
      }
      actions={decision || undefined}
      what={label}
    />
  );
}

/**
 * "Pedir a um admin" in the inbox of whoever may decide it (`change_request`): the same card, theirs to decide (a new
 * agent's, created as them from here).
 */
export function ChangeRequestCard({ n }: { n: AppNotification }) {
  const { org } = useOrg();
  const proposalId = n.source.proposalId;
  const rows = useCardProposals(org.id, proposalId ? [proposalId] : []);
  const agentCard = useAgentProposal(org.id, proposalId ? null : (n.source.messageId ?? null)).data;
  const [p] = rows;
  const removal = removalOf(rows);
  if (p && removal) return <RemovalCard rows={rows} removal={removal} />;
  if (p) return <SettingsRow p={p} />;
  if (!agentCard) return null;
  return (
    <AgentProposalCardView
      messageId={agentCard.messageId}
      proposerId={agentCard.proposedByAgentId}
      sentAt={n.createdAt}
      card={agentCard}
    />
  );
}

/**
 * The right hand's approvals card (`offer_approvals`, ADR 0137 §4): each approval as the conversation shows it, with its
 * own buttons, holds and confirmations, decided as whoever clicks (audited via the right hand); decided, its one line.
 */
export function ApprovalsCardView({ message, card }: { message: Message; card: ApprovalsCard }) {
  const { t } = useTranslation();
  return (
    <CardVia messageId={message.id}>
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset */}
      <div className="rh-cards" role="group" aria-label={t("rightHand.approvals.title")}>
        {card.why && <p>{card.why}</p>}
        {card.approvalIds.map((id) => (
          <CardApproval key={id} id={id} />
        ))}
      </div>
    </CardVia>
  );
}

function CardApproval({ id }: { id: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const list = useApprovals(org.id);
  const listed = list.data?.find((a) => a.id === id);
  const one = useApproval(org.id, id, !listed && list.isSuccess);
  const people = useMembers(org.id).data;
  const members = new Map((people ?? []).map((m) => [m.userId, m]));
  const approval = listed ?? one.data;
  if (!approval) return null;
  const agent = dir.anyAgent(approval.agentId);
  return approval.status === "pending" ? (
    <ApprovalAsk approval={approval} agent={agent} members={members} />
  ) : (
    <InlineApproval approval={approval} agent={agent} members={members} />
  );
}

/**
 * The right hand's people card (`propose_member_changes`): a row per person and change ("Ganha Dono", "Perde Vendas",
 * "Remover do workspace"), each applied with the members screen's own call as whoever clicks, removal through its
 * confirmation. Who can't reads who may. Done from the members list.
 */
export function MemberChangesCardView({ message, card }: { message: Message; card: MemberChangesCard }) {
  return (
    <CardVia messageId={message.id}>
      <MemberChanges message={message} card={card} />
    </CardVia>
  );
}

function MemberChanges({ message, card }: { message: Message; card: MemberChangesCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const members = useMembers(org.id);
  const roles = useRoles(org.id).data?.roles ?? [];
  const change = useChangeRole(org.id);
  const setRoles = useSetMemberRoles(org.id);
  const toast = useToast();
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const people = members.data ?? [];
  const title = t("rightHand.people.title");
  const roleNames = (ids: string[]) =>
    ids
      .map((id) => roles.find((r) => r.id === id)?.name ?? "")
      .filter(Boolean)
      .join(", ");
  const owner = t("roles.owner");
  const what = (r: MemberChangeRow) =>
    "remove" in r
      ? t("members.remove.item")
      : "role" in r
        ? t(r.role === "owner" ? "rightHand.people.gets" : "rightHand.people.loses", { roles: owner })
        : [
            r.addRoleIds.length ? t("rightHand.people.gets", { roles: roleNames(r.addRoleIds) }) : "",
            r.removeRoleIds.length ? t("rightHand.people.loses", { roles: roleNames(r.removeRoleIds) }) : "",
          ]
            .filter(Boolean)
            .join(" · ");
  const may = (r: MemberChangeRow) =>
    "role" in r || ("remove" in r && people.find((p) => p.userId === r.userId)?.role === "owner")
      ? can(org, "manage_owners")
      : can(org, "manage_members");
  const done = (r: MemberChangeRow) => members.isSuccess && memberRowDone(r, people);
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const apply = (r: MemberChangeRow) => {
    if ("remove" in r) return setRemoving({ userId: r.userId, name: r.name });
    if ("role" in r) return change.mutate({ userId: r.userId, role: r.role }, { onError: failed });
    const now = people.find((p) => p.userId === r.userId)?.roleIds;
    setRoles.mutate({ userId: r.userId, roleIds: rolesAfter(r, now) }, { onError: failed });
  };
  if (members.isSuccess && card.rows.every(done)) {
    return (
      <RequestDone done label={title}>
        {t("rightHand.people.done")}: <b>{[...new Set(card.rows.map((r) => r.name))].join(", ")}</b>
      </RequestDone>
    );
  }
  const open = card.rows.filter((r) => !done(r));
  const mine = open.some(may);
  const blocked = open.some((r) => "role" in r && !may(r))
    ? "rightHand.people.onlyOwners"
    : "rightHand.people.onlyAdmins";
  return (
    <>
      <RemoveMemberDialog person={removing} onClose={() => setRemoving(null)} />
      <RequestCard
        id={message.id}
        kind="proposal"
        agent={dir.anyAgent(message.author.id ?? "")}
        label={title}
        mine={mine}
        waitingFor={mine ? undefined : t(blocked)}
        lead={card.why}
        body={
          <ul className="proposal-rows">
            {card.rows.map((r) => (
              <li key={`${r.userId}:${what(r)}`} className="proposal-row">
                <PersonAvatar id={r.userId} name={r.name} size="sm" />
                <span className="proposal-row__what">
                  <span className="proposal-row__name">{r.name}</span>
                  <span>{what(r)}</span>
                </span>
                {done(r) ? (
                  <span className="proposal-row__status">{t("rightHand.people.done")}</span>
                ) : (
                  may(r) && (
                    <Button
                      size="sm"
                      variant={"remove" in r ? "danger" : "primary"}
                      loading={
                        (change.isPending && change.variables?.userId === r.userId) ||
                        (setRoles.isPending && setRoles.variables?.userId === r.userId)
                      }
                      onClick={() => apply(r)}
                    >
                      {"remove" in r ? t("members.remove.item") : t("rightHand.card.apply")}
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        }
        what={title}
      />
    </>
  );
}

/**
 * The right hand's "Abrir" card (`offer_open_page`): the screen's name, its line, and Abrir, which goes there; the screen
 * asks what it always asks (a deletion's code and typed name, Stripe, our key dialogs) and checks who may. Who can't
 * reads it.
 */
export function OpenPageCardView({ card }: { card: OpenPageCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const server = useAuthConfig().data;
  const navigate = useNavigate();
  const page = APP_PAGES[card.page];
  const title =
    card.page === "agent"
      ? (dir.anyAgent(card.agentId ?? "")?.name ?? t("channel.unknownAgent"))
      : card.page === "channel"
        ? `#${channels.data?.find((c) => c.id === card.channelId)?.name ?? ""}`
        : t(page.label as never);
  const path = appPagePath(page.web, card);
  const section = SETTINGS_SECTIONS.find(
    (s) => page.web === `/settings/${s.id}` || page.web.startsWith(`/settings/${s.id}?`),
  );
  const allowed = section
    ? section.allowed(org, server) && (!page.may || can(org, page.may))
    : !page.may || can(org, page.may);
  return (
    <div className="waitcard">
      <span className="waitcard__top ac-iconline">
        <Icon name="external" size={16} />
        <span>{title}</span>
      </span>
      {card.why && <p>{card.why}</p>}
      <span className="waitcard__acts">
        {allowed && path ? (
          <Button size="sm" onClick={() => void navigate({ href: `/org/${org.id}${path}` })}>
            {t("rightHand.open.open")}
          </Button>
        ) : (
          <span className="small muted">{t("rightHand.open.notAllowed")}</span>
        )}
      </span>
    </div>
  );
}
