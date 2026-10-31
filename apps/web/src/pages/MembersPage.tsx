import type { InvitationWithStatus, InviteLink, JoinRequest } from "@agenteschat/client";
import {
  useAllInvitations,
  useApproveJoinRequest,
  useAuthConfig,
  useDenyJoinRequest,
  useInviteLinks,
  useInviteMany,
  useJoinRequests,
  useMakeInviteLink,
  usePeople,
  useResendInvitation,
  useRevokeInvitation,
  useRoles,
  useSetMemberRoles,
  useTurnOffInviteLink,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatMonth, formatPercent, formatShortDate, relativeTime, timeLeft } from "@agenteschat/client/lib/format";
import { approvalNews, askedLabel, JOIN_REASON_MAX, sendsEmail } from "@agenteschat/client/lib/join-requests";
import { membersFull } from "@agenteschat/client/lib/limits";
import { can } from "@agenteschat/client/lib/permissions";
import { rolesOf } from "@agenteschat/client/lib/roles";
import { emailsFrom } from "@agenteschat/client/lib/text";
import {
  Alert,
  ApprovalCard,
  Avatar,
  Button,
  Card,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  FilterBar,
  FilterChip,
  Input,
  List,
  PlanMeter,
  Textarea,
} from "@agenteschat/ui";
import { Link, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { OnlyYouNote } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useFilterCopy } from "@/components/filters";
import { MembersFull } from "@/components/Limits";
import { LoadingLine, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { RolesPicker } from "@/components/roles/RolesPicker";
import { RoleChip } from "@/components/roles/RolesSection";
import { useDirectory } from "@/hooks/useDirectory";
import { TYPED_VALUES } from "@/i18n";
import { copyText } from "@/lib/context-menu";
import { planMeterText, usageShown } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import "./members.css";

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

export function MembersPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const manage = can(org, "manage_members");
  const invites = can(org, "invite_people");
  // A server that sends no email invites by link only.
  const byLink = !sendsEmail(useAuthConfig().data);
  const invitations = useAllInvitations(org.id, invites);
  const inviteMany = useInviteMany(org.id);
  const resendOne = useResendInvitation(org.id);
  const revoke = useRevokeInvitation(org.id);
  const setRolesOf = useSetMemberRoles(org.id);
  const peopleQuery = usePeople(org.id);
  const orgRoles = useRoles(org.id).data?.roles ?? [];
  const full = membersFull(useWorkspaceLimits(org.id, invites).data) !== null;
  const [draft, setDraft] = useState("");
  const [inviteRoles, setInviteRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [resent, setResent] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const month = formatMonth(i18n.language, new Date());

  const send = async () => {
    const { valid, invalid } = emailsFrom(draft);
    if (valid.length === 0) {
      setError(t("members.invalidEmails"));
      return;
    }
    setError(null);
    const results = await inviteMany.mutateAsync({ emails: valid, roleIds: inviteRoles });
    const links: Record<string, string> = {};
    for (const r of results) if (r.url) links[r.email] = r.url;
    setLinks((prev) => ({ ...prev, ...links }));
    const invited = results.filter((r) => r.status === "invited").length;
    const problems = results.flatMap((r) => (r.status === "invited" ? [] : [{ ...r, status: r.status }]));
    if (invited > 0) toast.show(t("members.invited", { count: invited }));
    for (const email of invalid) toast.show(t("members.batch.invalid_email", { email }), "error");
    for (const p of problems) toast.show(t(`members.batch.${p.status}`, { email: p.email }), "error");
    // Only addresses to fix stay in the field: a member or a pending invitation was just said, and sending it
    // again would only say it again.
    const toFix = [...invalid, ...problems.filter((p) => p.status === "invalid_email").map((p) => p.email)];
    setDraft(toFix.join(", "));
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

  const [roles, setRoles] = useState<string[]>([]);
  // `?request=…&do=approve|deny`: the admins' email opens that request here.
  const search = useSearch({ strict: false }) as { request?: string; do?: string };
  const filterCopy = useFilterCopy();
  // The filter's values: `owner`, or a role's id.
  const people = (peopleQuery.data ?? []).filter(
    (m) =>
      roles.length === 0 || roles.some((r) => (r === "owner" ? m.role === "owner" : (m.roleIds ?? []).includes(r))),
  );
  const roleNames = (ids: readonly string[] = []) =>
    orgRoles
      .filter((r) => ids.includes(r.id))
      .map((r) => r.name)
      .join(", ");
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

      {invites && <JoinRequests focus={search.request} action={search.do} />}

      {invites && (
        <Card aria-labelledby="sec-invite">
          <h2 id="sec-invite" className="ac-card__title">
            {t("members.inviteTitle")}
          </h2>
          <MembersFull />
          <OnlyYouNote orgId={org.id} viewerId={me.user.id} />
          {!byLink && (
            <div className="row row--end">
              <Field
                label={t("members.emails")}
                id="m-email"
                style={{ flex: "1 1 280px" }}
                error={error}
                hint={{ name: t("common.about", { label: t("members.emails") }), text: t("members.link.emailsJoin") }}
              >
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
              <Field label={t("members.rolesLabel")} id="m-roles" style={{ flex: "0 1 200px" }}>
                <RolesPicker
                  roles={orgRoles}
                  value={inviteRoles}
                  onChange={setInviteRoles}
                  label={t("members.inviteRoles")}
                />
              </Field>
              <Button
                variant="primary"
                onClick={() => void send().catch(() => {})}
                disabled={inviteMany.isPending || full}
                loading={inviteMany.isPending}
              >
                {t("members.invite")}
              </Button>
            </div>
          )}
          <InviteLinkBlock alone={byLink} />
        </Card>
      )}

      {invites && pending.length > 0 && (
        <section aria-labelledby="sec-pending" className="section section--tight">
          <h2 id="sec-pending" className="section-title">
            {t("members.pendingTitle")}
          </h2>
          <List>
            {pending.map((inv) => (
              <div key={inv.id} className="ac-list__row">
                <span style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>{inv.email}</span>
                <span className="small muted" style={{ flex: "0 1 160px", minWidth: 0 }}>
                  {inv.role === "owner" ? t("roles.owner") : roleNames(inv.roleIds) || t("members.onlyEveryone")}
                </span>
                <span className="small muted" style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}>
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
        <FilterBar
          label={t("members.filters")}
          clearText={filterCopy.clearAll}
          onClear={() => setRoles([])}
          filters={[
            {
              key: "role",
              active: roles.length > 0,
              node: (
                <FilterChip
                  label={t("members.roleFilter")}
                  icon="members"
                  multiple
                  options={[
                    { value: "owner", label: t("roles.owner") },
                    ...orgRoles.filter((r) => r.kind === "custom").map((r) => ({ value: r.id, label: r.name })),
                  ]}
                  value={roles}
                  onChange={setRoles}
                  valueText={(o) => o.label}
                  countText={(count) => t("members.rolesCount", { count })}
                  clearLabel={filterCopy.clearOf(t("members.roleFilter"))}
                />
              ),
            },
          ]}
        />
        {peopleQuery.isLoading && <LoadingList count={3} trailing />}
        <List>
          {people.map((m) => {
            const isMe = m.userId === me.user.id;
            const held = rolesOf(m, orgRoles);
            // The server says who is below whom; here the "+" shows when there's anything to give.
            const gives = manage && (m.role !== "owner" || org.role === "owner") && orgRoles.some((r) => r.givable);
            return (
              <div key={m.userId} className="ac-list__row">
                <Avatar
                  size="sm"
                  name={m.name}
                  imageUrl={m.image}
                  presence={m.presence}
                  presenceLabel={t(`presence.${m.presence}`)}
                />
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
                <span className="members-roles">
                  {m.role === "owner" && (
                    <Chip icon="audienceOwner" title={t("roles.ownerTitle")}>
                      {t("roles.owner")}
                    </Chip>
                  )}
                  {held.map((r) => (
                    <RoleChip key={r.id} role={r} />
                  ))}
                  {gives && (
                    <RolesPicker
                      roles={orgRoles}
                      value={m.roleIds ?? []}
                      onChange={(roleIds) =>
                        setRolesOf.mutate(
                          { userId: m.userId, roleIds },
                          { onError: (e) => toast.show(errorText(t, e), "error") },
                        )
                      }
                      label={t("members.rolesOf", { name: m.name })}
                      trigger={
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          icon="plus"
                          aria-label={t("members.rolesOf", { name: m.name })}
                        />
                      }
                    />
                  )}
                </span>
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
          {can(org, "create_agents") && (
            <Link to="/org/$orgId/agents/new" params={{ orgId: org.id }} className="ac-link" style={{ fontSize: 14 }}>
              {t("shell.createAgent")}
            </Link>
          )}
        </div>
        <List>
          {dir.agents.length === 0 && <div className="ac-list__row muted">{t("members.noAgents")}</div>}
          {dir.agents.map((a) => {
            const owner = a.ownerUserId ? dir.memberById.get(a.ownerUserId) : undefined;
            // Its plan's limits, the budget under them only once it spent through the API (ADR 0063 §5).
            const shown = usageShown(a.brain, a.budgetUsedPercent ?? 0);
            const budget = shown.budget && a.budgetUsedPercent !== undefined;
            return (
              <Link
                key={a.id}
                to="/org/$orgId/agents/$agentId"
                params={{ orgId: org.id, agentId: a.id }}
                className="ac-list__row"
              >
                <AgentAvatar agentId={a.id} size="sm" name={a.name} />
                <span className="list-col">
                  <span style={{ fontWeight: 600 }}>
                    {a.name}
                    {a.role ? ` · ${a.role}` : ""}
                  </span>
                  <span className="small muted">
                    {owner ? t("members.ownerLine", { name: owner.name }) : t("members.noOwner")}
                  </span>
                </span>
                {(shown.plan || budget) && (
                  <div className="list-col" style={{ flex: "0 1 220px", gap: 4 }}>
                    {shown.plan && (
                      <PlanMeter
                        compact
                        usage={shown.plan.usage}
                        text={planMeterText(t, i18n.language)}
                        label={shown.plan.account}
                      />
                    )}
                    {budget && (
                      <span className="small muted tabular">
                        {t("members.budgetLine", {
                          percent: formatPercent(i18n.language, a.budgetUsedPercent ?? 0),
                          month,
                        })}
                      </span>
                    )}
                  </div>
                )}
              </Link>
            );
          })}
        </List>
      </section>
    </div>
  );
}

/**
 * Members › Requests (ADR 0068): who asked to join through the invitation link, oldest first, each answered with
 * a role or denied with a reason. `focus` (from the admins' email): that request in view with Approve focused,
 * which the admin still presses, or its Deny dialog open.
 */
function JoinRequests({ focus, action }: { focus?: string; action?: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const list = useJoinRequests(org.id);
  const approve = useApproveJoinRequest(org.id);
  const deny = useDenyJoinRequest(org.id);
  const full = membersFull(useWorkspaceLimits(org.id).data) !== null;
  const orgRoles = useRoles(org.id).data?.roles ?? [];
  const [roles, setRoles] = useState<Record<string, string[]>>({});
  const [denying, setDenying] = useState<JoinRequest | null>(null);
  const [reason, setReason] = useState("");
  const [handOff, setHandOff] = useState<{ name: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [gone, setGone] = useState(false);
  const approveButtons = useRef(new Map<string, HTMLButtonElement>());
  const opened = useRef<string | null>(null);
  const requests = list.data ?? [];

  useEffect(() => {
    if (!focus || opened.current === focus || !list.data) return;
    opened.current = focus;
    const request = list.data.find((r) => r.id === focus);
    if (!request) return setGone(true);
    if (action === "deny") {
      setReason("");
      return setDenying(request);
    }
    const button = approveButtons.current.get(request.id);
    button?.scrollIntoView({ block: "center" });
    button?.focus();
  }, [focus, action, list.data]);

  const approveOne = (r: JoinRequest) =>
    approve.mutate(
      { id: r.id, roleIds: roles[r.id] ?? [] },
      {
        onSuccess: (result) => {
          const news = approvalNews(result);
          if ("send" in news) {
            setCopied(false);
            setHandOff({ name: r.name, url: news.send });
          } else if (news.said === "joined") toast.show(t("members.requests.joined", { name: r.name }));
          else toast.show(t("members.requests.invited", { email: r.email }));
        },
      },
    );
  const denyOne = () => {
    if (!denying) return;
    deny.mutate(
      { id: denying.id, reason: reason.trim() || undefined },
      {
        onSuccess: () => toast.show(t("members.requests.denied")),
        onSettled: () => setDenying(null),
      },
    );
  };

  return (
    <>
      {gone && <Alert tone="neutral">{t("members.requests.gone")}</Alert>}
      {requests.length > 0 && (
        <section aria-labelledby="sec-requests" className="section section--tight">
          <h2 id="sec-requests" className="section-title">
            {t("members.requests.title")} <span className="jr-count">{requests.length}</span>
          </h2>
          <MembersFull />
          <div className="jr-list">
            {requests.map((r) => {
              const answering =
                (approve.isPending && approve.variables?.id === r.id) ||
                (deny.isPending && deny.variables?.id === r.id);
              return (
                <ApprovalCard
                  key={r.id}
                  id={`join-request-${r.id}`}
                  status="waiting"
                  wide
                  aria-label={t("members.requests.label", { name: r.name })}
                  avatar={<Avatar size="sm" name={r.name} />}
                  who={
                    <>
                      <span>
                        <Trans
                          i18nKey="members.requests.asks"
                          values={{ name: r.name }}
                          components={{ b: <b /> }}
                          {...TYPED_VALUES}
                        />
                      </span>
                      <span className="jr-chips">
                        {!r.verified && <Chip icon="mail">{t("members.requests.unverified")}</Chip>}
                        <Chip icon="waiting" tone="waiting">
                          {askedLabel(t, i18n.language, r.createdAt)}
                        </Chip>
                      </span>
                    </>
                  }
                  title={r.email}
                  why={r.note ? t("members.requests.note", { note: r.note }) : undefined}
                  actions={
                    <>
                      <div className="jr-role">
                        <RolesPicker
                          size="sm"
                          roles={orgRoles}
                          value={roles[r.id] ?? []}
                          onChange={(ids) => setRoles((prev) => ({ ...prev, [r.id]: ids }))}
                          label={t("members.requests.roleOf", { name: r.name })}
                        />
                      </div>
                      <Button
                        ref={(el) => {
                          if (el) approveButtons.current.set(r.id, el);
                          else approveButtons.current.delete(r.id);
                        }}
                        size="sm"
                        variant="primary"
                        disabled={answering || full}
                        loading={approve.isPending && approve.variables?.id === r.id}
                        onClick={() => approveOne(r)}
                      >
                        {t("members.requests.approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ac-btn--danger"
                        disabled={answering}
                        onClick={() => {
                          setReason("");
                          setDenying(r);
                        }}
                      >
                        {t("members.requests.deny")}
                      </Button>
                    </>
                  }
                />
              );
            })}
          </div>
        </section>
      )}
      <Dialog
        open={denying !== null}
        onOpenChange={(open) => !open && setDenying(null)}
        title={t("members.requests.denyTitle", { name: denying?.name ?? "" })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogBody>
          <Field label={t("members.requests.reason")} id="join-deny-reason" help={t("members.requests.reasonHelp")}>
            <Textarea rows={3} maxLength={JOIN_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setDenying(null)}>{t("common.cancel")}</Button>
          <Button variant="danger" loading={deny.isPending} onClick={denyOne}>
            {t("members.requests.deny")}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={handOff !== null}
        onOpenChange={(open) => !open && setHandOff(null)}
        title={t("members.requests.copyTitle", { name: handOff?.name ?? "" })}
        description={t("members.requests.copyText")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogBody>
          <div className="jr-copy">
            <Input
              readOnly
              value={handOff?.url ?? ""}
              aria-label={t("members.requests.copyTitle", { name: handOff?.name ?? "" })}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              icon={copied ? "check" : "copy"}
              onClick={() => handOff && void copyText(handOff.url, () => setCopied(true))}
            >
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          </div>
        </DialogBody>
      </Dialog>
    </>
  );
}

/**
 * The workspace's invitation link (ADR 0068), in the "Invite people" card: whoever has it can only ask to join,
 * and an admin approves each person. Links made before links could be shown again are listed to turn off.
 */
/** `alone`: the card's only way in (no email form above), so no hairline over it. */
function InviteLinkBlock({ alone = false }: { alone?: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const links = useInviteLinks(org.id);
  const make = useMakeInviteLink(org.id);
  const turnOff = useTurnOffInviteLink(org.id);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState<InviteLink | null>(null);
  const all = links.data ?? [];
  const current = all.find((l) => l.url !== null);
  const until = (l: InviteLink) => formatShortDate(i18n.language, l.expiresAt);
  const turnOffButton = (l: InviteLink) => (
    <Button variant="ghost" size="sm" className="ac-btn--danger" onClick={() => setClosing(l)}>
      {t("members.link.turnOff")}
    </Button>
  );

  return (
    <div className={alone ? "jr-link jr-link--alone" : "jr-link"}>
      <span className="ac-field__label" id="invite-link-label">
        {t("members.link.title")}
      </span>
      {links.isPending ? (
        <LoadingLine width={320} />
      ) : current?.url ? (
        <>
          <div className="jr-copy">
            <Input
              readOnly
              value={current.url}
              aria-labelledby="invite-link-label"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              icon={copied ? "check" : "copy"}
              onClick={() => void copyText(current.url ?? "", () => setCopied(true))}
            >
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          </div>
          <div className="jr-link__foot">
            <span className="small muted">{t("members.link.help", { date: until(current) })}</span>
            {turnOffButton(current)}
          </div>
        </>
      ) : (
        <div>
          <Button loading={make.isPending} onClick={() => make.mutate()}>
            {t("members.link.make")}
          </Button>
        </div>
      )}
      {all
        .filter((l) => l.url === null)
        .map((l) => {
          const when = relativeTime(t, i18n.language, l.createdAt);
          return (
            <div key={l.id} className="jr-link__foot">
              <span className="small muted">
                {l.createdBy
                  ? t("members.link.earlier", { when, name: l.createdBy, date: until(l) })
                  : t("members.link.earlierNoName", { when, date: until(l) })}
              </span>
              {turnOffButton(l)}
            </div>
          );
        })}
      <Dialog
        open={closing !== null}
        onOpenChange={(open) => !open && setClosing(null)}
        title={t("members.link.turnOffTitle")}
        description={t("members.link.turnOffText", { count: closing?.waiting ?? 0 })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setClosing(null)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={turnOff.isPending}
            onClick={() => closing && turnOff.mutate(closing.id, { onSettled: () => setClosing(null) })}
          >
            {t("members.link.turnOff")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
