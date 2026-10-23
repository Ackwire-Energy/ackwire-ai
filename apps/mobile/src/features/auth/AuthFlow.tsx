import { ApiError, type SignInOptions, useApi, useAuthConfig } from "@agenteschat/client";
import { emailTypoFix, isEmail, passwordState, webmailOf } from "@agenteschat/client/lib/text";
import { router } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, View } from "react-native";
import { API_URL } from "@/config";
import { authClient } from "@/lib/auth";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { rememberSignIn, SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

/**
 * Sign in and sign up in one flow (telas/EntrarCadastro.html, C, like the web's `AuthPage`): the e-mail
 * first, then the one next step the server says it needs (the password, the provider the account signs
 * in with, or the name and a new password). "Esqueci a senha" happens in place. The agent reacts: eyes
 * shut while a hidden password is typed, a wink when it's shown, a frown when it's wrong. On success the
 * session gate moves to the app.
 */
type Step = "email" | "password" | "social" | "name" | "newPassword" | "closed" | "forgot" | "sent";

/** Where the back button goes from each step (`null`: leave the screen, if there is somewhere to go). */
const BACK: Record<Step, Step | null> = {
  email: null,
  password: "email",
  social: "email",
  name: "email",
  newPassword: "name",
  closed: "email",
  forgot: "password",
  sent: "password",
};

const TERMS_URL = "https://agentes.chat/terms";
const PRIVACY_URL = "https://agentes.chat/privacy";

export function AuthFlow({ start, email: initialEmail }: { start: "in" | "up"; email?: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const config = useAuthConfig();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState(false);
  const [wink, setWink] = useState(false);
  const linkedProviders = useSocialProviders(options?.providers);
  const allProviders = useSocialProviders();
  const canReset = config.data?.passwordReset === true;

  const go = (next: Step) => {
    setError(null);
    setWrong(false);
    setSecret(false);
    setStep(next);
  };

  /** Who is this e-mail: the next step follows from the server's answer. */
  const lookUp = async (value = email) => {
    if (!isEmail(value)) return;
    setPending(true);
    setError(null);
    try {
      const found = await api.account.signInOptions({ email: value.trim() });
      setOptions(found);
      setPassword("");
      if (found.account) go(found.password ? "password" : "social");
      else go(found.canSignUp ? "name" : "closed");
    } catch (e) {
      setError(
        e instanceof ApiError
          ? t(e.status === 429 ? "auth.tooManyTries" : "mobile.auth.errors.generic")
          : t("mobile.auth.errors.network"),
      );
    } finally {
      setPending(false);
    }
  };

  // Came with the e-mail ("Criar conta" from somewhere that knew it): straight to the next step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the e-mail it came with
  useEffect(() => {
    if (initialEmail && isEmail(initialEmail)) void lookUp(initialEmail);
  }, []);

  /** Better Auth's answer → the sentence to show (never the server's raw text). */
  const failed = (status: number | undefined) =>
    setError(
      status === 429
        ? t("auth.tooManyTries")
        : status === undefined || status === 0
          ? t("mobile.auth.errors.network")
          : t("mobile.auth.errors.generic"),
    );

  const signIn = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await authClient.signIn.email({ email: email.trim(), password });
      if (res.error) {
        haptics.warning();
        if (res.error.status === 401) setWrong(true);
        else failed(res.error.status);
        return;
      }
      haptics.success();
      rememberSignIn("email");
    } catch {
      failed(undefined);
    } finally {
      setPending(false);
    }
  };

  const signUp = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await authClient.signUp.email({ name: name.trim(), email: email.trim(), password });
      if (res.error) {
        haptics.warning();
        if (res.error.status === 403) go("closed");
        else failed(res.error.status);
        return;
      }
      haptics.success();
      rememberSignIn("email");
    } catch {
      failed(undefined);
    } finally {
      setPending(false);
    }
  };

  const sendReset = async () => {
    setPending(true);
    setError(null);
    try {
      // The answer is the same whether or not the account exists; the link opens the website.
      const res = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: `${API_URL}/reset-password`,
      });
      if (res.error) return failed(res.error.status);
      haptics.success();
      go("sent");
    } catch {
      failed(undefined);
    } finally {
      setPending(false);
    }
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

  const submit = () => {
    if (!ready || pending) return;
    if (step === "email") void lookUp();
    else if (step === "password") void signIn();
    else if (step === "name") go("newPassword");
    else if (step === "newPassword") void signUp();
    else if (step === "forgot") void sendReset();
  };

  const showWink = () => {
    setWink(true);
    setTimeout(() => setWink(false), 900);
  };

  const expression = wrong ? "cross" : wink ? "wink" : secret ? "closed" : step === "sent" ? "happy" : undefined;

  const first = name.trim().split(/\s+/)[0] ?? "";
  const providerNames = linkedProviders.map((p) => t(`auth.provider.${p}`)).join(" · ");
  const bubble: Record<Step, [string, string]> = {
    email:
      start === "up"
        ? [t("auth.flow.emailUp"), t("auth.flow.emailUpLead")]
        : [t("auth.flow.email"), t("auth.flow.emailLead")],
    password: wrong
      ? [t("auth.flow.wrong"), canReset ? t("auth.flow.wrongLead") : t("auth.flow.wrongLeadNoReset")]
      : [t("auth.flow.password"), t("auth.flow.passwordLead")],
    social: [t("auth.flow.social", { providers: providerNames }), t("auth.flow.socialLead")],
    name: [t("auth.flow.name"), t("auth.flow.nameLead")],
    newPassword: [
      first ? t("auth.flow.newPasswordNamed", { name: first }) : t("auth.flow.newPassword"),
      t("auth.passwordHelp"),
    ],
    closed: [t("auth.flow.closed"), t("auth.flow.closedLead")],
    forgot: [t("auth.flow.forgot"), t("auth.flow.forgotLead")],
    sent: [t("auth.flow.sent", { email: email.trim() }), t("auth.flow.sentLead")],
  };
  const [title, lead] = bubble[step];

  const backTo = step === "forgot" && !options?.password ? "email" : BACK[step];
  const onBack = backTo ? () => go(backTo) : router.canGoBack() ? () => router.back() : undefined;

  const fix = step === "email" || step === "forgot" ? emailTypoFix(email) : null;
  const mail = webmailOf(email);

  const submitLabel: Partial<Record<Step, string>> = {
    email: t("auth.flow.continue"),
    password: t("auth.signIn"),
    name: t("auth.flow.continue"),
    newPassword: t("auth.createAccount"),
    forgot: t("auth.flow.sendLink"),
  };

  return (
    <AuthScaffold
      title={title}
      subtitle={lead}
      stepKey={step}
      onBack={onBack}
      agentMode={pending ? "run" : "idle"}
      expression={expression}
      footer={step === "email" || step === "newPassword" ? <Terms /> : null}
    >
      {step !== "email" && step !== "forgot" && step !== "sent" ? (
        <Who email={email.trim()} onChange={() => go("email")} />
      ) : null}

      {step === "email" || step === "forgot" ? (
        <>
          <AuthField
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              setError(null);
            }}
            placeholder={t("auth.flow.emailPlaceholder")}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="username"
            returnKeyType={step === "email" ? "next" : "send"}
            onSubmitEditing={submit}
            accessibilityLabel={t("auth.email")}
            autoFocus={!initialEmail}
          />
          {fix ? (
            <Pressable onPress={() => setEmail(fix)} accessibilityRole="button" hitSlop={6}>
              <Text variant="subhead" style={{ fontWeight: "600" }}>
                {t("auth.flow.didYouMean", { email: fix })}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {step === "password" || step === "newPassword" ? (
        <PasswordField
          value={password}
          onChangeText={(value) => {
            setPassword(value);
            setWrong(false);
          }}
          fresh={step === "newPassword"}
          onSecretChange={setSecret}
          onShow={showWink}
          onSubmitEditing={submit}
          label={step === "newPassword" ? t("invite.createPassword") : t("auth.password")}
        />
      ) : null}

      {step === "name" ? (
        <AuthField
          value={name}
          onChangeText={setName}
          placeholder={t("auth.flow.namePlaceholder")}
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          onSubmitEditing={submit}
          accessibilityLabel={t("auth.yourName")}
          autoFocus
        />
      ) : null}

      {error ? (
        <Text tone="danger" variant="small" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}

      {submitLabel[step] ? (
        <Button variant="primary" wide label={submitLabel[step]} disabled={!ready || pending} onPress={submit} />
      ) : null}

      {step === "email" ? <SocialButtons providers={allProviders} onError={setError} /> : null}

      {step === "password" && canReset ? <Quiet label={t("auth.forgotPassword")} onPress={() => go("forgot")} /> : null}

      {step === "social" ? (
        <>
          <SocialButtons providers={linkedProviders} divider={false} onError={setError} />
          {canReset ? <Quiet label={t("auth.flow.createPassword")} onPress={() => go("forgot")} /> : null}
        </>
      ) : null}

      {step === "closed" ? (
        <Button variant="secondary" wide label={t("auth.flow.otherEmail")} onPress={() => go("email")} />
      ) : null}

      {step === "forgot" ? (
        <Quiet label={t("auth.flow.back")} onPress={() => go(options?.password ? "password" : "email")} />
      ) : null}

      {step === "sent" ? (
        <>
          {mail ? (
            <Button
              variant="primary"
              wide
              icon="mail"
              label={t("auth.flow.openMail", { app: mail.name })}
              onPress={() => void Linking.openURL(mail.url)}
            />
          ) : null}
          <Button
            variant="secondary"
            wide
            label={t("auth.flow.backToSignIn")}
            onPress={() => go(options?.password ? "password" : "email")}
          />
        </>
      ) : null}
    </AuthScaffold>
  );
}

/** The e-mail being answered for, with "Trocar". */
function Who({ email, onChange }: { email: string; onChange: () => void }) {
  const { t } = useTranslation();
  const { colors, shadows } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        alignSelf: "flex-start",
        maxWidth: "100%",
        minHeight: 32,
        paddingLeft: 10,
        paddingRight: 4,
        borderRadius: 10,
        backgroundColor: colors.raised,
        boxShadow: shadows.e1,
      }}
    >
      <Icon name="mail" size={16} color={colors.muted} />
      <Text variant="subhead" numberOfLines={1} style={{ flexShrink: 1 }}>
        {email}
      </Text>
      <Pressable onPress={onChange} accessibilityRole="button" hitSlop={8} style={{ paddingHorizontal: 8 }}>
        <Text variant="subhead" style={{ fontWeight: "600" }}>
          {t("auth.flow.change")}
        </Text>
      </Pressable>
    </View>
  );
}

/** A quiet text link under the main answer ("Esqueci a senha"). */
function Quiet({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <View style={{ alignItems: "center", marginTop: 4 }}>
      <AuthLink label={label} onPress={onPress} />
    </View>
  );
}

/** "Ao continuar, você aceita os Termos e a Política de privacidade." */
function Terms() {
  const { t } = useTranslation();
  const link = (label: string, url: string): ReactNode => (
    <Text
      variant="caption"
      tone="muted"
      style={{ textDecorationLine: "underline" }}
      onPress={() => void Linking.openURL(url)}
    >
      {label}
    </Text>
  );
  return (
    <Text variant="caption" tone="muted" style={{ textAlign: "center" }}>
      {t("auth.termsBefore")}
      {link(t("auth.terms"), TERMS_URL)}
      {t("auth.termsMiddle")}
      {link(t("auth.privacy"), PRIVACY_URL)}
      {t("auth.termsAfter")}
    </Text>
  );
}
