import { Avatar, Button, Card, Field, Input, List, Select, type SelectOption } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useChangeRole, useInvitations, useInvite, usePresence, useRevokeInvitation, useUsage } from "@/api/queries";
import type { Invitation, Role } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { formatMonth, formatShortDate, formatUsd, relativeTime, timeLeft } from "@/lib/format";
import { can } from "@/lib/permissions";
import { parseEmails } from "@/lib/text";
import { useToast } from "@/lib/toast";

const DAY = 86_400_000;
const INVITE_TTL_DAYS = 7;

/** "Enviado há 2 dias · expira em 5 dias" (sent time = expiry − 7 days). */
export function invitationStatus(
  t: Parameters<typeof timeLeft>[0],
  locale: string,
  invitation: Invitation,
  now = new Date(),
) {
  const sentAt = new Date(new Date(invitation.expiresAt).getTime() - INVITE_TTL_DAYS * DAY).toISOString();
  const left = timeLeft(t, invitation.expiresAt, now) ?? "";
  if (now.getTime() - new Date(sentAt).getTime() < 60_000) return t("members.sentNow");
  return t("members.sentAgo", { ago: relativeTime(t, locale, sentAt, now), left });
}

/** telas/Membros.dc.html */
export function MembersPage() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const manage = can(org.role, "manage_members");
  const invitations = useInvitations(org.id, manage);
  const invite = useInvite(org.id);
  const revoke = useRevokeInvitation(org.id);
  const changeRole = useChangeRole(org.id);
  const presence = usePresence(org.id);
  const usage = useUsage(org.id);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [resent, setResent] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const month = formatMonth(i18n.language, new Date());

  const roleOptions: SelectOption<Role>[] = [
    { value: "member", label: t("roles.member"), description: t("roles.memberDesc") },
    { value: "admin", label: t("roles.admin"), description: t("roles.adminDesc") },
    ...(can(org.role, "manage_owners")
      ? [{ value: "owner" as Role, label: t("roles.owner"), description: t("roles.ownerTitle") }]
      : []),
  ];

  const send = async () => {
    const emails = parseEmails(draft);
    if (emails.length === 0) {
      setError(t("members.invalidEmails"));
      return;
    }
    setError(null);
    let ok = 0;
    for (const email of emails) {
      try {
        const res = await invite.mutateAsync({ email, role });
        setLinks((prev) => ({ ...prev, [res.invitation.email]: res.url }));
        ok++;
      } catch {
        // The toast already says why (e.g. already a member).
      }
    }
    if (ok > 0) {
      setDraft("");
      toast.show(t("members.invited", { count: ok }));
    }
  };

  /** No resend endpoint: revoke and create a new invitation (new link, 7 more days). */
  const resend = async (inv: Invitation) => {
    await api.orgs.revokeInvitation(org.id, inv.id);
    const res = await invite.mutateAsync({ email: inv.email, role: inv.role });
    setLinks((prev) => ({ ...prev, [inv.email]: res.url }));
    setResent((prev) => ({ ...prev, [inv.email]: true }));
  };

  const copy = async (email: string) => {
    const url = links[email];
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      toast.show(url);
    }
    setCopied(email);
  };

  const people = dir.members;
  const pending = invitations.data ?? [];

  return (
    <div className="page" style={{ gap: 28 }}>
      <header className="page__header">
        <h1 className="page-title">{t("members.title")}</h1>
        <p className="page-sub">
          {t("members.subtitle", {
            count: people.length,
            people: people.length,
            agents: dir.agents.length,
            org: org.name,
          })}
        </p>
      </header>

      {manage && (
        <Card aria-labelledby="sec-invite">
          <h2 id="sec-invite" className="ac-card__title">
            {t("members.inviteTitle")}
          </h2>
          <div className="row row--end">
            <Field label={t("members.emails")} id="m-email" style={{ flex: "1 1 280px" }} error={error}>
              <Input
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={t("members.emailsPlaceholder")}
              />
            </Field>
            <Field label={t("members.role")} id="m-role" style={{ flex: "0 1 150px" }}>
              <Select value={role} onValueChange={setRole} options={roleOptions.filter((o) => o.value !== "owner")} />
            </Field>
            <Button variant="primary" onClick={() => void send()} disabled={invite.isPending}>
              {t("members.invite")}
            </Button>
          </div>
          <span className="small muted">{t("members.roleNote")}</span>
        </Card>
      )}

      {manage && pending.length > 0 && (
        <section aria-labelledby="sec-pending" className="section section--tight">
          <h2 id="sec-pending" className="section-title">
            {t("members.pendingTitle")}
          </h2>
          <List>
            {pending.map((inv) => (
              <div key={inv.id} className="ac-list__row">
                <span style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>{inv.email}</span>
                <span className="small muted" style={{ flex: "0 0 72px" }}>
                  {t(`roles.${inv.role}`)}
                </span>
                <span className="small muted" style={{ flex: "0 1 180px" }}>
                  {resent[inv.email] ? t("members.resentNow") : invitationStatus(t, i18n.language, inv)}
                </span>
                <div className="row" style={{ gap: 4 }}>
                  {links[inv.email] && (
                    <Button variant="ghost" size="sm" onClick={() => void copy(inv.email)}>
                      {copied === inv.email ? t("members.linkCopied") : t("members.copyLink")}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void resend(inv).catch(() => {})}>
                    {resent[inv.email] ? t("members.resent") : t("members.resend")}
                  </Button>
                  <Button variant="ghost" size="sm" className="ac-btn--danger" onClick={() => revoke.mutate(inv.id)}>
                    {t("members.revoke")}
                  </Button>
                </div>
              </div>
            ))}
          </List>
        </section>
      )}

      <section aria-labelledby="sec-people" className="section section--tight">
        <h2 id="sec-people" className="section-title">
          {t("members.people")}
        </h2>
        <List>
          {people.map((m) => {
            const isMe = m.userId === me.user.id;
            const seen = presence.data?.[m.userId];
            const editable = manage && !isMe && (m.role !== "owner" || can(org.role, "manage_owners"));
            return (
              <div key={m.userId} className="ac-list__row">
                <Avatar size="sm" name={m.name} imageUrl={m.image} />
                <span className="list-col">
                  <span style={{ fontWeight: 600 }}>
                    {m.name}
                    {isMe ? t("common.youSuffix") : ""}
                  </span>
                  <span className="small muted" style={{ overflowWrap: "anywhere" }}>
                    {m.email}
                  </span>
                </span>
                <span className="small muted" style={{ flex: "0 1 160px" }}>
                  {seen && Date.now() - new Date(seen).getTime() < 5 * 60_000
                    ? t("members.activeNow")
                    : t("members.joined", { when: formatShortDate(i18n.language, m.joinedAt) })}
                </span>
                {editable ? (
                  <div style={{ flex: "0 0 130px", width: 130 }}>
                    <Select
                      size="sm"
                      aria-label={t("members.roleOf", { name: m.name })}
                      value={m.role}
                      onValueChange={(v) => changeRole.mutate({ userId: m.userId, role: v })}
                      options={roleOptions}
                    />
                  </div>
                ) : (
                  <span
                    title={m.role === "owner" ? t("roles.ownerTitle") : undefined}
                    style={{ flex: "0 0 130px", fontSize: 14, fontWeight: m.role === "owner" ? 600 : 400 }}
                  >
                    {t(`roles.${m.role}`)}
                  </span>
                )}
              </div>
            );
          })}
        </List>
      </section>

      <section aria-labelledby="sec-agents" className="section section--tight">
        <div className="section__head">
          <h2 id="sec-agents" className="section-title">
            {t("members.agents")}
          </h2>
          {can(org.role, "manage_agents") && (
            <Link to="/org/$orgId/agents/new" params={{ orgId: org.id }} className="ac-link" style={{ fontSize: 14 }}>
              {t("members.createAgent")}
            </Link>
          )}
        </div>
        <List>
          {dir.agents.length === 0 && <div className="ac-list__row muted">{t("members.noAgents")}</div>}
          {dir.agents.map((a) => {
            const owner = a.ownerUserId ? dir.memberById.get(a.ownerUserId) : undefined;
            const spent = usage.data?.find((u) => u.agentId === a.id)?.costUsd ?? 0;
            return (
              <Link
                key={a.id}
                to="/org/$orgId/agents/$agentId"
                params={{ orgId: org.id, agentId: a.id }}
                className="ac-list__row"
              >
                <Avatar kind="agent" size="sm" name={a.name} initials={dir.agentInitials(a.id)} />
                <span className="list-col">
                  <span style={{ fontWeight: 600 }}>
                    {a.name}
                    {a.role ? ` · ${a.role}` : ""}
                  </span>
                  <span className="small muted">
                    {owner ? t("members.ownerLine", { name: owner.name }) : t("members.noOwner")}
                  </span>
                </span>
                {usage.data && (
                  <span className="small muted tabular" style={{ flex: "0 1 220px" }}>
                    {a.monthlyBudgetUsd === null
                      ? t("members.budgetLineNoLimit", { spent: formatUsd(t, i18n.language, spent), month })
                      : t("members.budgetLine", {
                          spent: formatUsd(t, i18n.language, spent),
                          budget: formatUsd(t, i18n.language, a.monthlyBudgetUsd),
                          month,
                        })}
                  </span>
                )}
              </Link>
            );
          })}
        </List>
      </section>
    </div>
  );
}
