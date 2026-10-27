import type { AskToJoinResult, InvitationPreview } from "@agenteschat/client";
import { invitationQuery, keys, useAuthConfig, useMe } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { signInPath } from "@agenteschat/client/lib/guards";
import { ANSWER_POLL_MS, askView, JOIN_NAME_MAX, JOIN_NOTE_MAX } from "@agenteschat/client/lib/join-requests";
import { emailTypoFix, isEmail, passwordState } from "@agenteschat/client/lib/text";
import { Alert, AvatarStack, Button, Card, Field, Input, Textarea } from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { CenteredLayout } from "@/components/AuthLayout";
import { TYPED_VALUES } from "@/i18n";
import { lookOf } from "@/lib/look";
import "./invite.css";

/** An invitation, valid or expired; an invitation link only lets people ask to join (`AskToJoin`). */
export function InvitePage({ token }: { token: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const preview = useQuery(invitationQuery(api, token));
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const accept = useMutation({
    mutationFn: () => api.orgs.acceptInvitation(token),
    meta: { silent: true },
    onSuccess: async ({ orgId }) => {
      await qc.invalidateQueries({ queryKey: keys.me });
      await navigate({ to: "/org/$orgId", params: { orgId } });
    },
    onError: (e) =>
      setError(
        // Full: the person invited can only ask whoever invited them to make room.
        errorCode(e) === "org.members_full"
          ? t("errors.org.membersFull")
          : e instanceof Error
            ? e.message
            : t("common.unknownError"),
      ),
  });

  const signUpAndAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    const invitation = preview.data;
    if (!invitation) return;
    setError(null);
    const result = await auth.signUp({ name: name.trim(), email: invitation.email, password });
    if (!result.ok) {
      setError(result.message || t("common.unknownError"));
      return;
    }
    accept.mutate();
  };

  if (preview.isPending || me.isPending) {
    return (
      <CenteredLayout narrow>
        <Card padded aria-busy="true">
          <p className="muted">{t("common.loading")}</p>
        </Card>
      </CenteredLayout>
    );
  }

  const invitation = preview.data;
  if (invitation?.kind === "link") return <AskToJoin token={token} preview={invitation} />;
  const orgName = invitation?.orgName ?? "";
  const user = me.data?.user;
  const passwordOk = passwordState(password) === "ok";

  return (
    <CenteredLayout narrow>
      <Card padded as="div">
        {invitation && <OrgHead orgName={orgName} />}

        {invitation ? (
          <>
            <div className="stack-4">
              <h1 className="page-title page-title--sm">{t("invite.invitedYouNoName", { org: orgName })}</h1>
              <p className="page-sub">
                <Trans
                  i18nKey="invite.joinAs"
                  values={{ role: t(`roles.${invitation.role}Lower`) }}
                  components={{ b: <b style={{ color: "var(--ink)" }} /> }}
                />
              </p>
            </div>
            {error && <Alert>{error}</Alert>}
            {user ? (
              user.email.toLowerCase() === invitation.email.toLowerCase() ? (
                <>
                  <p className="page-sub">{t("invite.signedInAs", { email: user.email })}</p>
                  <Button
                    variant="primary"
                    block
                    disabled={accept.isPending}
                    loading={accept.isPending}
                    onClick={() => accept.mutate()}
                  >
                    {t("invite.accept", { org: orgName })}
                  </Button>
                </>
              ) : (
                <>
                  <Alert tone="neutral">{t("invite.wrongAccount", { email: invitation.email })}</Alert>
                  <Button
                    block
                    onClick={async () => {
                      await auth.signOut();
                      qc.clear();
                      await navigate({
                        to: "/login",
                        search: { redirect: `/invite/${token}`, email: invitation.email },
                      });
                    }}
                  >
                    {t("auth.signOut")}
                  </Button>
                </>
              )
            ) : (
              <form onSubmit={signUpAndAccept} style={{ display: "flex", flexDirection: "column", gap: 20 }} noValidate>
                <Field
                  label={t("auth.email")}
                  id="inv-email"
                  hint={{ name: t("common.about", { label: t("auth.email") }), text: t("invite.emailHelp") }}
                >
                  <Input value={invitation.email} readOnly />
                </Field>
                <Field label={t("auth.yourName")} id="inv-name">
                  <Input
                    autoComplete="name"
                    spellCheck={false}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label={t("invite.createPassword")} id="inv-pass" help={t("auth.passwordHelp")}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Button
                  type="submit"
                  variant="primary"
                  block
                  disabled={!name.trim() || !passwordOk || accept.isPending}
                  loading={accept.isPending}
                >
                  {t("invite.accept", { org: orgName })}
                </Button>
                <p className="auth__foot" style={{ margin: 0, fontSize: 14 }}>
                  {t("invite.haveAccountWithEmail")}{" "}
                  <a className="ac-link" href={signInPath(`/invite/${token}`, invitation.email)}>
                    {t("auth.signIn")}
                  </a>
                </p>
              </form>
            )}
          </>
        ) : (
          <>
            <div className="stack-4" style={{ gap: 8 }}>
              <h1 className="page-title page-title--sm">{t("invite.expiredTitle")}</h1>
              <p className="page-sub">{t("invite.expiredText")}</p>
            </div>
            <Button
              variant="primary"
              block
              disabled={asked}
              onClick={async () => {
                await api.invites.requestNew(token);
                setAsked(true);
              }}
            >
              {asked ? t("invite.askedNew") : t("invite.askNew")}
            </Button>
          </>
        )}
      </Card>
    </CenteredLayout>
  );
}

/** The workspace an invitation is for: its initial, this server's address and its name. */
function OrgHead({ orgName }: { orgName: string }) {
  return (
    <div className="row" style={{ gap: 12 }}>
      <span className="org-badge" aria-hidden="true">
        {orgName.trim()[0]?.toUpperCase()}
      </span>
      <div className="stack-4" style={{ gap: 0 }}>
        <span className="small muted">{window.location.host}</span>
        <span style={{ fontWeight: 700, fontSize: 18, lineHeight: "24px" }}>{orgName}</span>
      </div>
    </div>
  );
}

/** One of the page's answers: the guide's face, what happened, and what to do next. */
function Outcome({
  expression,
  title,
  children,
  action,
}: {
  expression?: "happy" | "closed";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="invite-ask__outcome" aria-live="polite">
      <AgentAvatar name="agentes.chat" size="lg" expression={expression} />
      <div className="invite-ask__outcome-text">
        <h1 className="page-title page-title--sm">{title}</h1>
        {children}
      </div>
      {action}
    </div>
  );
}

/**
 * An invitation link (ADR 0068): whoever opens it asks, and an admin of the workspace approves each person.
 * Signed out they type a name and an email, and no account is made: the answer comes by email. Signed in their
 * account asks, and the page checks for the answer while it is open.
 */
function AskToJoin({ token, preview }: { token: string; preview: InvitationPreview }) {
  const { t } = useTranslation();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const config = useAuthConfig();
  const user = me.data?.user ?? null;
  const [sent, setSent] = useState<AskToJoinResult | null>(null);
  const view = askView(preview, sent !== null);
  useQuery({
    ...invitationQuery(api, token),
    refetchInterval: user && (view.state === "sent" || view.state === "approvedEmail") ? ANSWER_POLL_MS : false,
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ask = useMutation({
    mutationFn: () =>
      api.invites.ask(token, {
        ...(user ? {} : { name: name.trim(), email: email.trim() }),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    meta: { silent: true },
    onSuccess: async (result) => {
      setSent(result);
      if (user) await qc.invalidateQueries({ queryKey: keys.invitation(token) });
    },
    onError: (e) => setError(errorText(t, e)),
  });

  const org = preview.orgName;
  const address = sent?.email ?? preview.you?.email ?? user?.email ?? "";
  const emailsGoOut = sent?.emailed ?? config.data?.passwordReset ?? true;
  const agents = preview.agents ?? [];
  const more = preview.moreAgents ?? 0;
  const fix = user ? null : emailTypoFix(email);
  const ready = user !== null || (name.trim() !== "" && isEmail(email));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || ask.isPending) return;
    setError(null);
    ask.mutate();
  };

  let body: ReactNode;
  switch (view.state) {
    case "closed":
      body = (
        <Outcome expression="closed" title={t("invite.ask.closedTitle")}>
          <p className="page-sub">{t("invite.ask.closedText")}</p>
        </Outcome>
      );
      break;
    case "in":
      body = (
        <Outcome
          expression="happy"
          title={view.already ? t("invite.ask.memberTitle", { org }) : t("invite.ask.inTitle", { org })}
          action={
            view.orgId && (
              <Button
                variant="primary"
                block
                onClick={async () => {
                  await qc.invalidateQueries({ queryKey: keys.me });
                  await navigate({ to: "/org/$orgId", params: { orgId: view.orgId ?? "" } });
                }}
              >
                {t("invite.ask.open", { org })}
              </Button>
            )
          }
        />
      );
      break;
    case "approvedEmail":
      body = (
        <Outcome expression="happy" title={t("invite.ask.approvedTitle")}>
          <p className="page-sub">
            {emailsGoOut ? t("invite.ask.approvedEmail", { email: address }) : t("invite.ask.approvedNoEmail")}
          </p>
        </Outcome>
      );
      break;
    case "denied":
      body = (
        <Outcome expression="closed" title={t("invite.ask.deniedTitle")}>
          {view.reason && (
            <p className="invite-ask__reason">
              <Trans
                i18nKey="invite.ask.reasonSaid"
                values={{ reason: view.reason }}
                components={{ b: <b /> }}
                {...TYPED_VALUES}
              />
            </p>
          )}
          <p className="page-sub">{t("invite.ask.deniedText", { org })}</p>
        </Outcome>
      );
      break;
    case "sent":
      body = (
        <Outcome expression="happy" title={t("invite.ask.sentTitle")}>
          <p className="page-sub">
            {user?.emailVerified
              ? t("invite.ask.sentAccount")
              : emailsGoOut
                ? t("invite.ask.sentEmail", { email: address })
                : t("invite.ask.sentNoEmail")}
          </p>
        </Outcome>
      );
      break;
    case "form":
      body = (
        <>
          <div className="stack-4" style={{ gap: 8 }}>
            <h1 className="page-title page-title--sm">{t("invite.ask.title", { org })}</h1>
            <p className="page-sub">
              {preview.invitedBy
                ? t("invite.ask.lead", { name: preview.invitedBy.split(/\s+/)[0] })
                : t("invite.ask.leadNoName")}
            </p>
          </div>
          {agents.length > 0 && (
            <div className="invite-ask__agents ac-iconline">
              <AvatarStack aria-hidden="true">
                {agents.map((a) => (
                  <AgentAvatar key={a.id} name={a.name} appearance={lookOf(a)} size="sm" />
                ))}
              </AvatarStack>
              <span>
                {t("invite.ask.agents", {
                  count: agents.length + more,
                  names: joinNames(
                    [...agents.map((a) => a.name), ...(more ? [t("invite.ask.moreAgents", { count: more })] : [])],
                    t("newAgent.and"),
                  ),
                })}
              </span>
            </div>
          )}
          <form className="invite-ask__form" onSubmit={submit} noValidate>
            {user ? (
              <p className="page-sub">
                {t("invite.ask.as", { email: user.email })}{" "}
                <button
                  type="button"
                  className="ac-link"
                  onClick={async () => {
                    await auth.signOut();
                    qc.clear();
                  }}
                >
                  {t("invite.ask.notYou")}
                </button>
              </p>
            ) : (
              <>
                <Field label={t("invite.ask.name")} id="ask-name">
                  <Input
                    autoComplete="name"
                    maxLength={JOIN_NAME_MAX}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label={t("invite.ask.email")} id="ask-email">
                  <Input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    spellCheck={false}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                {fix && (
                  <button type="button" className="auth__fix" onClick={() => setEmail(fix)}>
                    {t("auth.flow.didYouMean", { email: fix })}
                  </button>
                )}
              </>
            )}
            <Field label={t("invite.ask.note")} id="ask-note">
              <Textarea
                rows={2}
                maxLength={JOIN_NOTE_MAX}
                placeholder={t("invite.ask.noteHelp")}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            {error && <Alert>{error}</Alert>}
            <Button type="submit" variant="primary" block disabled={!ready} loading={ask.isPending}>
              {t("invite.ask.send")}
            </Button>
            {!user && (
              <p className="auth__foot" style={{ margin: 0, fontSize: 14 }}>
                {t("invite.ask.haveAccount")}{" "}
                <a className="ac-link" href={signInPath(`/invite/${token}`, isEmail(email) ? email.trim() : undefined)}>
                  {t("auth.signIn")}
                </a>
              </p>
            )}
          </form>
        </>
      );
      break;
  }

  return (
    <CenteredLayout narrow>
      <Card padded as="div">
        <OrgHead orgName={org} />
        {body}
      </Card>
    </CenteredLayout>
  );
}
