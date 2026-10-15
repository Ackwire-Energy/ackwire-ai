import { Avatar, Button, Card, Field, Input, List, Select, type SelectOption } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAllInvitations,
  useChangeRole,
  useInviteMany,
  usePeople,
  useResendInvitation,
  useRevokeInvitation,
  useUsage,
} from "@/api/queries";
import type { InvitationWithStatus, Role } from "@/api/types";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { formatMonth, formatShortDate, formatUsd, relativeTime, timeLeft } from "@/lib/format";
import { can } from "@/lib/permissions";
import { parseEmails } from "@/lib/text";
import { useToast } from "@/lib/toast";

/** "Enviado há 2 dias · expira em 5 dias" / "Expirou ontem". */
export function invitationStatus(
  t: Parameters<typeof timeLeft>[0],
  locale: string,
  invitation: InvitationWithStatus,
  now = new Date(),
) {
  const left = timeLeft(t, invitation.expiresAt, now);
  if (invitation.status === "expired" || !left) {
    return t("members.expiredAgo", { when: relativeTime(t, locale, invitation.expiresAt, now) });
  }
  if (now.getTime() - new Date(invitation.createdAt).getTime() < 60_000) return t("members.sentNow");
  return t("members.sentAgo", { ago: relativeTime(t, locale, invitation.createdAt, now), left });
}

/** telas/Membros.dc.html */
export function MembersPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const manage = can(org.role, "manage_members");
  const invitations = useAllInvitations(org.id, manage);
  const inviteMany = useInviteMany(org.id);
  const resendOne = useResendInvitation(org.id);
  const revoke = useRevokeInvitation(org.id);
  const changeRole = useChangeRole(org.id);
  const peopleQuery = usePeople(org.id);
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
    const results = await inviteMany.mutateAsync({ emails, role });
    const links: Record<string, string> = {};
    for (const r of results) if (r.url) links[r.email] = r.url;
    setLinks((prev) => ({ ...prev, ...links }));
    const invited = results.filter((r) => r.status === "invited").length;
    const problems = results.flatMap((r) => (r.status === "invited" ? [] : [{ ...r, status: r.status }]));
    if (invited > 0) toast.show(t("members.invited", { count: invited }));
    for (const p of problems) toast.show(t(`members.batch.${p.status}`, { email: p.email }), "error");
    if (problems.length === 0) setDraft("");
    else setDraft(problems.map((p) => p.email).join(", "));
  };

  const resend = async (inv: InvitationWithStatus) => {
    const res = await resendOne.mutateAsync(inv.id);
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

  const people = peopleQuery.data ?? [];
  const pending = invitations.data ?? [];

  return (
    <div className={embedded ? "settings__section" : "page"} style={{ gap: 28 }}>
      <header className="page__header">
        {embedded ? (
          <h2 className="page-title">{t("members.title")}</h2>
        ) : (
          <h1 className="page-title">{t("members.title")}</h1>
        )}
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
            <Button
              variant="primary"
              onClick={() => void send().catch(() => {})}
              disabled={inviteMany.isPending}
              loading={inviteMany.isPending}
            >
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
        {peopleQuery.isLoading && <LoadingList count={3} trailing />}
        <List>
          {people.map((m) => {
            const isMe = m.userId === me.user.id;
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
                  {m.online
                    ? t("members.activeNow")
                    : m.lastSeenAt
                      ? t("members.seen", { when: relativeTime(t, i18n.language, m.lastSeenAt) })
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
