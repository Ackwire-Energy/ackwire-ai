import { ApiError, type SignInOptions, useApi, useAuthConfig } from "@agenteschat/client";
import { emailTypoFix, isEmail, passwordState, webmailOf } from "@agenteschat/client/lib/text";
import { Button, Icon, Input } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { prepareBurst } from "@/components/Sky";
import { rememberSignIn, SocialButtons, useSocialProviders } from "@/components/SocialButtons";

/**
 * Sign in and sign up in one flow (telas/EntrarCadastro.html, C): the e-mail
 * first, then the one next step the server says it needs (the password, the
 * provider the account signs in with, or the name and a new password).
 * "Esqueci a senha" happens in place. The agent reacts to what you do.
 */
type Step = "email" | "password" | "social" | "name" | "newPassword" | "closed" | "forgot" | "sent";

/** Help under a new password, live: what's missing, or "Senha ok." */
export function passwordHelp(t: TFunction, password: string) {
  const state = passwordState(password);
  if (state === "empty") return { text: t("auth.passwordHelp"), invalid: false };
  if (state === "ok") return { text: t("auth.passwordOk"), invalid: false };
  if (state === "long") return { text: t("auth.passwordTooLong"), invalid: true };
  return { text: t("auth.passwordMissing", { count: 8 - password.length }), invalid: true };
}

/** A new password's help: one pixel per character up to the 8 needed, then "Senha ok." */
export function PasswordHelp({ password }: { password: string }) {
  const { t } = useTranslation();
  const help = passwordHelp(t, password);
  const ok = passwordState(password) === "ok";
  return (
    <span className={help.invalid ? "auth__help auth__help--bad" : ok ? "auth__help auth__help--ok" : "auth__help"}>
      <span className="auth__meter" aria-hidden="true" data-done={ok || undefined}>
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: eight fixed cells
          <i key={i} data-on={i < password.length || undefined} />
        ))}
      </span>
      {help.text}
    </span>
  );
}

export function AuthPage({ start, redirect, email: initialEmail }: { start: "in" | "up"; redirect?: string; email?: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const auth = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const config = useAuthConfig();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [pending, setPending] = useState(false);
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [passFocus, setPassFocus] = useState(false);
  const [wink, setWink] = useState(false);
  const header = useRef<HTMLElement>(null);
  const linkedProviders = useSocialProviders(options?.providers);
  const allProviders = useSocialProviders();
  const canReset = config.data?.passwordReset === true;

  const go = (next: Step) => {
    setError(null);
    setWrong(false);
    setShow(false);
    setStep(next);
  };

  const fail = (e: unknown) =>
    setError(e instanceof ApiError && e.status === 429 ? t("auth.tooManyTries") : t("common.unknownError"));

  /** Who is this e-mail: the next step follows from the server's answer. */
  const lookUp = async (value = email) => {
    setPending(true);
    setError(null);
    try {
      const found = await api.account.signInOptions({ email: value.trim() });
      setOptions(found);
      setPassword("");
      if (found.account) go(found.password ? "password" : "social");
      else go(found.canSignUp ? "name" : "closed");
    } catch (e) {
      fail(e);
    } finally {
      setPending(false);
    }
  };

  // Came with the e-mail (an invitation's "Entrar"): straight to the next step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the e-mail in the link
  useEffect(() => {
    if (initialEmail && isEmail(initialEmail)) void lookUp(initialEmail);
  }, []);

  const enter = async (to: string) => {
    prepareBurst(header.current ?? document.body)();
    qc.clear();
    await navigate({ to });
  };

  const signIn = async () => {
    setPending(true);
    setError(null);
    const result = await auth.signIn({ email: email.trim(), password });
    setPending(false);
    if (!result.ok) {
      setWrong(result.status === 401);
      setError(result.status === 401 ? null : result.message || t("common.unknownError"));
      return;
    }
    rememberSignIn("email");
    await enter(redirect ?? "/");
  };

  const signUp = async () => {
    setPending(true);
    setError(null);
    const result = await auth.signUp({ name: name.trim(), email: email.trim(), password });
    setPending(false);
    if (!result.ok) {
      if (result.status === 403) return go("closed");
      setError(result.message || t("common.unknownError"));
      return;
    }
    rememberSignIn("email");
    await enter(redirect ?? "/onboarding");
  };

  const sendReset = async () => {
    setPending(true);
    setError(null);
    const result = await auth.requestPasswordReset({
      email: email.trim(),
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message || t("common.unknownError"));
      return;
    }
    go("sent");
  };

  const ready =
    step === "email" || step === "forgot"
      ? isEmail(email)
      : step === "password"
        ? password.length > 0
        : step === "name"
          ? name.trim().length > 0
          : step === "newPassword"
            ? passwordState(password) === "ok"
            : false;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || pending) return;
    if (step === "email") void lookUp();
    else if (step === "password") void signIn();
    else if (step === "name") go("newPassword");
    else if (step === "newPassword") void signUp();
    else if (step === "forgot") void sendReset();
  };

  const capsKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false);
  const toggleShow = () => {
    setShow((s) => !s);
    if (!show) {
      setWink(true);
      setTimeout(() => setWink(false), 900);
    }
  };

  // The agent: eyes shut while you type a hidden password, a wink when you show it, a frown when it's wrong.
  const secret = (step === "password" || step === "newPassword") && passFocus && !show;
  const expression = wrong ? "cross" : wink ? "wink" : secret ? "closed" : step === "sent" ? "happy" : undefined;

  const first = name.trim().split(/\s+/)[0] ?? "";
  const providerNames = linkedProviders.map((p) => t(`auth.provider.${p}`)).join(" · ");
  const bubble: Record<Step, [string, string]> = {
    email: start === "up" ? [t("auth.flow.emailUp"), t("auth.flow.emailUpLead")] : [t("auth.flow.email"), t("auth.flow.emailLead")],
    password: wrong ? [t("auth.flow.wrong"), canReset ? t("auth.flow.wrongLead") : t("auth.flow.wrongLeadNoReset")] : [t("auth.flow.password"), t("auth.flow.passwordLead")],
    social: [t("auth.flow.social", { providers: providerNames }), t("auth.flow.socialLead")],
    name: [t("auth.flow.name"), t("auth.flow.nameLead")],
    newPassword: [first ? t("auth.flow.newPasswordNamed", { name: first }) : t("auth.flow.newPassword"), t("auth.passwordHelp")],
    closed: [t("auth.flow.closed"), t("auth.flow.closedLead")],
    forgot: [t("auth.flow.forgot"), t("auth.flow.forgotLead")],
    sent: [t("auth.flow.sent", { email: email.trim() }), t("auth.flow.sentLead")],
  };
  const [title, lead] = bubble[step];

  const fix = step === "email" || step === "forgot" ? emailTypoFix(email) : null;
  const help = passwordHelp(t, password);
  const mail = webmailOf(email);
  const who = step !== "email" && step !== "forgot" && step !== "sent" && (
    <span className="auth__who">
      <Icon name="mail" size={14} />
      <span className="auth__who-email">{email.trim()}</span>
      <button type="button" className="auth__who-change" onClick={() => go("email")}>
        {t("auth.flow.change")}
      </button>
    </span>
  );

  const passwordInput = (fresh: boolean) => (
    <div className="auth__pass">
      <Input
        className="auth__big"
        type={show ? "text" : "password"}
        aria-label={fresh ? t("invite.createPassword") : t("auth.password")}
        autoComplete={fresh ? "new-password" : "current-password"}
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setWrong(false);
        }}
        onKeyDown={capsKey}
        onKeyUp={capsKey}
        onFocus={() => setPassFocus(true)}
        onBlur={() => setPassFocus(false)}
        invalid={wrong || (fresh && help.invalid)}
        autoFocus
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        iconOnly
        icon={show ? "eyeOff" : "eye"}
        aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")}
        aria-pressed={show}
        className="auth__eye"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleShow}
      />
    </div>
  );

  const capsNote = caps && passFocus && (
    <span className="auth__caps">
      <Icon name="arrowUp" size={14} />
      {t("auth.capsLock")}
    </span>
  );

  const submitLabel: Partial<Record<Step, string>> = {
    email: t("auth.flow.continue"),
    password: t("auth.signIn"),
    name: t("auth.flow.continue"),
    newPassword: t("auth.createAccount"),
    forgot: t("auth.flow.sendLink"),
  };

  return (
    <AuthShell>
      <form className="auth__form" onSubmit={submit} noValidate>
        <header className="auth__ask" ref={header} data-burst>
          <AgentAvatar name="agentes.chat" size="lg" state={pending ? "writing" : undefined} expression={expression} />
          <div className="auth__bubble" key={`${step}-${wrong}`} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            <p className="auth__lead">{lead}</p>
          </div>
        </header>

        <div className="auth__step" key={step}>
          {who}

          {(step === "email" || step === "forgot") && (
            <div className="auth__field">
              <Input
                className="auth__big"
                type="email"
                inputMode="email"
                aria-label={t("auth.email")}
                autoComplete="email"
                placeholder={t("auth.flow.emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={error !== null}
                autoFocus
              />
              {fix && (
                <button type="button" className="auth__fix" onClick={() => setEmail(fix)}>
                  {t("auth.flow.didYouMean", { email: fix })}
                </button>
              )}
            </div>
          )}

          {step === "password" && (
            <div className="auth__field">
              {passwordInput(false)}
              {capsNote}
            </div>
          )}

          {step === "name" && (
            <Input
              className="auth__big"
              aria-label={t("auth.yourName")}
              autoComplete="name"
              placeholder={t("auth.flow.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          )}

          {step === "newPassword" && (
            <div className="auth__field">
              {passwordInput(true)}
              <PasswordHelp password={password} />
              {capsNote}
            </div>
          )}

          {error && (
            <p className="auth__error" role="alert">
              <Icon name="alert" size={14} />
              {error}
            </p>
          )}

          {submitLabel[step] && (
            <Button type="submit" variant="primary" size="lg" block kbd={["↵"]} loading={pending} disabled={!ready}>
              {submitLabel[step]}
            </Button>
          )}

          {step === "email" && allProviders.length > 0 && (
            <>
              <div className="auth__or">{t("common.or")}</div>
              <SocialButtons callbackURL={redirect ?? "/"} providers={allProviders} />
            </>
          )}

          {step === "password" && canReset && (
            <button type="button" className="auth__quiet" onClick={() => go("forgot")}>
              {t("auth.forgotPassword")}
            </button>
          )}

          {step === "social" && (
            <>
              <SocialButtons callbackURL={redirect ?? "/"} providers={linkedProviders} />
              {canReset && (
                <button type="button" className="auth__quiet" onClick={() => go("forgot")}>
                  {t("auth.flow.createPassword")}
                </button>
              )}
            </>
          )}

          {step === "closed" && (
            <Button type="button" size="lg" block onClick={() => go("email")}>
              {t("auth.flow.otherEmail")}
            </Button>
          )}

          {step === "forgot" && (
            <button type="button" className="auth__quiet" onClick={() => go(options?.password ? "password" : "email")}>
              {t("auth.flow.back")}
            </button>
          )}

          {step === "sent" && (
            <>
              {mail && (
                <Button asChild variant="primary" size="lg" block>
                  <a href={mail.url} target="_blank" rel="noopener noreferrer">
                    {t("auth.flow.openMail", { app: mail.name })}
                  </a>
                </Button>
              )}
              <Button type="button" size="lg" block onClick={() => go("password")}>
                {t("auth.flow.backToSignIn")}
              </Button>
            </>
          )}

          {(step === "email" || step === "newPassword") && (
            <p className="auth__fine">
              {t("auth.termsBefore")}
              <a href="https://agentes.chat/termos">{t("auth.terms")}</a>
              {t("auth.termsMiddle")}
              <a href="https://agentes.chat/privacidade">{t("auth.privacy")}</a>
              {t("auth.termsAfter")}
            </p>
          )}
        </div>
      </form>
    </AuthShell>
  );
}
