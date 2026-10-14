import { Alert, Button, Card, Field, Input } from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useMe } from "@/api/queries";
import { useAuth } from "@/auth/context";
import { CenteredLayout } from "@/components/AuthLayout";
import { passwordState } from "@/lib/text";

/** telas/Convite.dc.html — valid and expired states. */
export function InvitePage({ token }: { token: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const preview = useQuery({
    queryKey: keys.invitation(token),
    queryFn: () => api.orgs.previewInvitation(token),
    retry: false,
  });
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
    onError: (e) => setError(e instanceof Error ? e.message : t("common.unknownError")),
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
  const orgName = invitation?.orgName ?? "";
  const user = me.data?.user;
  const passwordOk = passwordState(password) === "ok";

  return (
    <CenteredLayout narrow>
      <Card padded as="div">
        {invitation && (
          <div className="row" style={{ gap: 12 }}>
            <span className="org-badge" aria-hidden="true">
              {orgName.trim()[0]?.toUpperCase()}
            </span>
            <div className="stack-4" style={{ gap: 0 }}>
              <span className="small muted">{window.location.host}</span>
              <span style={{ fontWeight: 700, fontSize: 18, lineHeight: "24px" }}>{orgName}</span>
            </div>
          </div>
        )}

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
                  <Button variant="primary" block disabled={accept.isPending} onClick={() => accept.mutate()}>
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
                <Field label={t("auth.email")} id="inv-email" help={t("invite.emailHelp")}>
                  <Input value={invitation.email} readOnly />
                </Field>
                <Field label={t("auth.yourName")} id="inv-name">
                  <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
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
                >
                  {t("invite.accept", { org: orgName })}
                </Button>
                <p className="auth__foot" style={{ margin: 0, fontSize: 14 }}>
                  {t("invite.haveAccountWithEmail")}{" "}
                  <a
                    className="ac-link"
                    href={`/login?redirect=${encodeURIComponent(`/invite/${token}`)}&email=${encodeURIComponent(invitation.email)}`}
                  >
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
