import type { AskToJoinResult, InvitationPreview } from "@agenteschat/client";
import { ApiError, invitationQuery, keys, useAuthConfig, useMe } from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { authErrorText, errorCode, errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { signInPath } from "@agenteschat/client/lib/guards";
import { withHumanCheck } from "@agenteschat/client/lib/human-check";
import {
  ANSWER_POLL_MS,
  askView,
  JOIN_CODE_LENGTH,
  JOIN_NAME_MAX,
  JOIN_NOTE_MAX,
  joinCode,
} from "@agenteschat/client/lib/join-requests";
import { emailTypoFix, isEmail, passwordState } from "@agenteschat/client/lib/text";
import { Alert, AvatarStack, Button, Card, Field, Icon, Input, Textarea } from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { CenteredLayout } from "@/components/AuthLayout";
import { useNow } from "@/hooks/useNow";
import { TYPED_VALUES } from "@/i18n";
import { useHumanCheck } from "@/lib/human-check";
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
  // Signed out on an email invitation: the sign-up form below.
  const human = useHumanCheck(preview.data && preview.data.kind !== "link" && me.data === null ? "sign-up" : null);

  const accept = useMutation({
    mutationFn: () => api.orgs.acceptInvitation(token),
    meta: { silent: true },
    onSuccess: async ({ orgId }) => {
      await qc.invalidateQueries({ queryKey: keys.me });
      await navigate({ to: "/org/$orgId", params: { orgId } });
    },
    onError: (e) => setError(e instanceof Error ? e.message : t("common.unknownError")),
  });

  const signUpAndAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    const invitation = preview.data;
    if (!invitation) return;
    setError(null);
    const result = await withHumanCheck(human.check, (humanCheck) =>
      auth.signUp({ name: name.trim(), email: invitation.email, password }, humanCheck),
    );
    if (!result.ok) {
      setError(authErrorText(t, result));
      return;
    }
    accept.mutate();
  };

  if (preview.isPending || me.isPending) {
    return (
      <CenteredLayout narrow>
        <Card padded className="invite-card" aria-busy="true">
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
      <Card padded as="div" className="invite-card">
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
                {human.slot}
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
 * The ask's email with Verify beside it (ADR 0072): a code goes to the address, and typed back here it proves it.
 * Verify, the countdown, Resend and Verified share one slot as wide as the longest, so the field never moves.
 * A code and a proof belong to the address they were for: editing the email starts over. `onEmail` absent: the
 * signed-in account's own address, read-only.
 */
function EmailProof({
  token,
  email,
  onEmail,
  aside,
  proven,
  onProven,
  children,
}: {
  token: string;
  email: string;
  onEmail?: (email: string) => void;
  aside?: ReactNode;
  proven: boolean;
  onProven: (code: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const human = useHumanCheck("ask-code");
  const key = email.trim().toLowerCase();
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<{ email: string; text: string } | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const out = sent?.email === key;
  // A repaint every second while the countdown runs; the time itself is read below.
  useNow((n) => (out && !proven && sent && n < sent.resendAt ? 1000 : false));
  const said = error?.email === key ? error.text : null;
  const body = onEmail ? { email: email.trim() } : {};
  const codeOut = (resendIn: number) => {
    setSent({ email: key, resendAt: Date.now() + resendIn * 1000 });
    setCode("");
    setError(null);
  };
  const send = useMutation({
    mutationFn: () => withHumanCheck(human.check, (humanCheck) => api.invites.sendCode(token, body, humanCheck)),
    meta: { silent: true },
    onSuccess: (r) => codeOut(r.resendIn),
    onError: (e) => {
      // A code went out a moment ago (a reload, another tab): that one is still good.
      const retryIn = e instanceof ApiError && e.code === "join.code_wait" ? Number(e.params?.retryIn) : 0;
      if (retryIn > 0) codeOut(retryIn);
      else setError({ email: key, text: errorText(t, e) });
    },
  });
  const check = useMutation({
    mutationFn: (typed: string) => api.invites.checkCode(token, { ...body, code: typed }),
    meta: { silent: true },
    onSuccess: (_, typed) => {
      setError(null);
      onProven(typed);
    },
    onError: (e) => {
      setCode("");
      setError({ email: key, text: errorText(t, e) });
      codeInput.current?.focus();
    },
  });
  // Each code that goes out takes the focus once.
  useEffect(() => {
    if (sent) codeInput.current?.focus();
  }, [sent]);

  const left = out && sent ? Math.max(0, sent.resendAt - Date.now()) : 0;
  const slot = proven ? "verified" : !out ? "verify" : left > 0 ? "wait" : "resend";
  const shown = (s: typeof slot) => (slot === s ? undefined : ({ visibility: "hidden" } as const));
  const typed = (value: string) => {
    const digits = joinCode(value);
    setCode(digits);
    if (digits.length === JOIN_CODE_LENGTH && !check.isPending) check.mutate(digits);
  };
  const showCode = out && !proven;
  return (
    <>
      <Field label={t("invite.ask.email")} id="ask-email" labelAside={aside} error={showCode ? undefined : said}>
        <div className="invite-ask__verify">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            readOnly={!onEmail}
            onChange={(e) => onEmail?.(e.target.value)}
          />
          <span className="invite-ask__slot">
            <Button
              style={shown("verify")}
              disabled={!isEmail(email)}
              loading={send.isPending && !out}
              onClick={() => send.mutate()}
            >
              {t("invite.ask.verify")}
            </Button>
            <Button style={shown("resend")} loading={send.isPending && out} onClick={() => send.mutate()}>
              {t("invite.ask.resend")}
            </Button>
            <Button
              className="invite-ask__wait"
              style={shown("wait")}
              disabled
              aria-label={t("invite.ask.resendIn", { count: Math.ceil(left / 1000) })}
            >
              {formatTimeLeft(left)}
            </Button>
            <span className="invite-ask__verified ac-iconline" aria-hidden="true" style={{ visibility: "hidden" }}>
              <Icon name="check" size={16} />
              <span>{t("invite.ask.verified")}</span>
            </span>
            {/* Present all along, so screen readers hear "Verified" when it fills. */}
            <span className="invite-ask__verified ac-iconline" role="status">
              {slot === "verified" && (
                <>
                  <Icon name="check" size={16} />
                  <span>{t("invite.ask.verified")}</span>
                </>
              )}
            </span>
          </span>
        </div>
      </Field>
      {children}
      {human.slot}
      {showCode && (
        <Field label={t("invite.ask.code")} id="ask-code" error={said && <span role="alert">{said}</span>}>
          <Input
            ref={codeInput}
            className="invite-ask__code"
            inputMode="numeric"
            autoComplete="one-time-code"
            enterKeyHint="done"
            value={code}
            readOnly={check.isPending}
            aria-busy={check.isPending || undefined}
            onChange={(e) => typed(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (code.length === JOIN_CODE_LENGTH && !check.isPending) check.mutate(code);
            }}
          />
        </Field>
      )}
    </>
  );
}

/**
 * An invitation link (ADR 0068): whoever opens it asks, and an admin of the workspace approves each person.
 * Signed out they type a name and an email, and no account is made: the answer comes by email. Signed in their
 * account asks, and the page checks for the answer while it is open. On a server that sends email, an address that
 * isn't a confirmed account's proves itself first with a code (`EmailProof`, ADR 0072).
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
  const [proof, setProof] = useState<{ email: string; code: string } | null>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const emailsGoOut = sent?.emailed ?? config.data?.passwordReset ?? true;
  const proofNeeded = emailsGoOut && !user?.emailVerified;
  const typedEmail = user ? user.email : email;
  const proven = proof !== null && proof.email === typedEmail.trim().toLowerCase();
  const ask = useMutation({
    mutationFn: () =>
      api.invites.ask(token, {
        ...(user ? {} : { name: name.trim(), email: email.trim() }),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(proofNeeded && proof ? { code: proof.code } : {}),
      }),
    meta: { silent: true },
    onSuccess: async (result) => {
      setSent(result);
      if (user) await qc.invalidateQueries({ queryKey: keys.invitation(token) });
    },
    onError: (e) => {
      // The proof ran out (30 minutes) or was used: Verify again.
      if (errorCode(e)?.startsWith("join.code_")) setProof(null);
      setError(errorText(t, e));
    },
  });

  const org = preview.orgName;
  const address = sent?.email ?? preview.you?.email ?? user?.email ?? "";
  const agents = preview.agents ?? [];
  const more = preview.moreAgents ?? 0;
  const fix = user ? null : emailTypoFix(email);
  const ready = (user !== null || (name.trim() !== "" && isEmail(email))) && (!proofNeeded || proven);
  const signOut = (
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
  );
  const onProven = (code: string) => {
    setProof({ email: typedEmail.trim().toLowerCase(), code });
    noteInput.current?.focus();
  };
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
            {user && !proofNeeded && (
              <p className="page-sub">
                {t("invite.ask.as", { email: user.email })} {signOut}
              </p>
            )}
            {!user && (
              <Field label={t("invite.ask.name")} id="ask-name">
                <Input
                  autoComplete="name"
                  maxLength={JOIN_NAME_MAX}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            )}
            {user && proofNeeded && (
              <EmailProof token={token} email={user.email} aside={signOut} proven={proven} onProven={onProven} />
            )}
            {!user && proofNeeded && (
              <EmailProof token={token} email={email} onEmail={setEmail} proven={proven} onProven={onProven}>
                {fix && (
                  <button type="button" className="auth__fix" onClick={() => setEmail(fix)}>
                    {t("auth.flow.didYouMean", { email: fix })}
                  </button>
                )}
              </EmailProof>
            )}
            {!user && !proofNeeded && (
              <>
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
                ref={noteInput}
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
      <Card padded as="div" className="invite-card">
        <OrgHead orgName={org} />
        {body}
      </Card>
    </CenteredLayout>
  );
}
