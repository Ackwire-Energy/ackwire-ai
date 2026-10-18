import { useAuthConfig } from "@agenteschat/client";
import { isEmail, passwordState } from "@agenteschat/client/lib/text";
import { Alert, Button, Field, Input } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AuthLayout } from "@/components/AuthLayout";
import { SocialButtons, useHasSocial } from "@/components/SocialButtons";

/** Help text under the password, live (telas/Cadastro). */
export function passwordHelp(t: TFunction, password: string) {
  const state = passwordState(password);
  if (state === "empty") return { text: t("auth.passwordHelp"), invalid: false };
  if (state === "ok") return { text: t("auth.passwordOk"), invalid: false };
  if (state === "long") return { text: t("auth.passwordTooLong"), invalid: true };
  return { text: t("auth.passwordMissing", { count: 8 - password.length }), invalid: true };
}

/** telas/Cadastro.dc.html */
export function SignupPage({ redirect }: { redirect?: string }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const config = useAuthConfig();
  const hasSocial = useHasSocial();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const help = passwordHelp(t, password);
  const ok = name.trim().length > 0 && isEmail(email) && passwordState(password) === "ok";
  const closed = config.data && !config.data.signupOpen;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await auth.signUp({ name: name.trim(), email: email.trim(), password });
    setPending(false);
    if (!result.ok) {
      setError(result.status === 403 ? t("auth.signupClosed") : result.message || t("common.unknownError"));
      return;
    }
    qc.clear();
    await navigate({ to: redirect ?? "/onboarding" });
  };

  return (
    <AuthLayout aside="steps">
      <form className="auth__form" onSubmit={submit} noValidate>
        <div className="stack-4">
          <h1 className="page-title">{t("auth.signUpTitle")}</h1>
          <p className="page-sub">{t("auth.signUpSubtitle")}</p>
        </div>
        {closed && <Alert tone="neutral">{t("auth.signupClosed")}</Alert>}
        {error && <Alert>{error}</Alert>}
        {hasSocial && (
          <>
            <SocialButtons callbackURL={redirect ?? "/onboarding"} />
            <div className="auth__or">{t("auth.orWithEmail")}</div>
          </>
        )}
        <Field label={t("auth.yourName")} id="su-name">
          <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label={t("auth.workEmail")} id="su-email">
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field
          label={t("auth.password")}
          id="su-pass"
          help={help.invalid ? undefined : help.text}
          error={help.invalid ? help.text : undefined}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" block disabled={!ok || pending}>
          {t("auth.createAccount")}
        </Button>
        <p className="auth__fine">
          {t("auth.termsBefore")}
          <a href="https://agentes.chat/termos">{t("auth.terms")}</a>
          {t("auth.termsMiddle")}
          <a href="https://agentes.chat/privacidade">{t("auth.privacy")}</a>
          {t("auth.termsAfter")}
        </p>
        <p className="auth__foot" style={{ marginTop: 0 }}>
          {t("auth.haveAccount")}{" "}
          <Link to="/login" search={{ redirect }} className="ac-link">
            {t("auth.signIn")}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
