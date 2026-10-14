import { Alert, Button, Field, Input } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthConfig } from "@/api/queries";
import { useAuth } from "@/auth/context";
import { AuthLayout } from "@/components/AuthLayout";
import { SocialButtons, useHasSocial } from "@/components/SocialButtons";

/** telas/Entrar.dc.html */
export function LoginPage({ redirect, email: initialEmail }: { redirect?: string; email?: string }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const config = useAuthConfig();
  const hasSocial = useHasSocial();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await auth.signIn({ email, password });
    setPending(false);
    if (!result.ok) {
      setError(result.status === 401 ? t("auth.invalidCredentials") : result.message || t("common.unknownError"));
      return;
    }
    // Drop everything cached while signed out (including "no session").
    qc.clear();
    await navigate({ to: redirect ?? "/" });
  };

  return (
    <AuthLayout aside="demo">
      <form className="auth__form" onSubmit={submit} noValidate>
        <div className="stack-4">
          <h1 className="page-title">{t("auth.signInTitle")}</h1>
          <p className="page-sub">{t("auth.signInSubtitle")}</p>
        </div>
        {error && <Alert>{error}</Alert>}
        <Field label={t("auth.email")} id="login-email">
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label={t("auth.password")} id="login-pass">
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            invalid={error !== null}
            required
          />
        </Field>
        <Button type="submit" variant="primary" block disabled={pending || !email || !password}>
          {t("auth.signIn")}
        </Button>
        {hasSocial && (
          <>
            <div className="auth__or">{t("common.or")}</div>
            <SocialButtons callbackURL={redirect ?? "/"} />
          </>
        )}
        {config.data?.signupOpen && (
          <p className="auth__foot">
            {t("auth.noAccount")}{" "}
            <Link to="/signup" search={{ redirect }} className="ac-link">
              {t("auth.createAccount")}
            </Link>
          </p>
        )}
      </form>
    </AuthLayout>
  );
}
