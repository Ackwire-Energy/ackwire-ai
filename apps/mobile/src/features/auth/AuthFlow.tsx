import { invitationQuery, type SignInOptions, useApi, useAuthConfig } from "@agenteschat/client";
import { type HumanAction, humanCheckHeaders, withHumanCheck } from "@agenteschat/client/lib/human-check";
import { emailTypoFix, isEmail, passwordState, webmailOf } from "@agenteschat/client/lib/text";
import { useQuery } from "@tanstack/react-query";
import { router, useIsFocused } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, type TextInput, View } from "react-native";
import { useLaunched } from "@/features/launch/launched";
import { authClient } from "@/lib/auth";
import { readValueSync, writeValue } from "@/lib/storage";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { ServerLine } from "@/ui/auth/ServerLine";
import { rememberSignIn, SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { rememberConfirmationSent } from "./confirmation";
import { useHumanCheck } from "./HumanCheck";
import {
  CheckCancelled,
  earlyAccessRequests,
  lookUpFailureText,
  lookUpStep,
  refusalOf,
  refusalText,
  signUpClosed,
} from "./human-check";
import { pendingInvite } from "./invite";
import { signInPurpose } from "./links";

/**
 * Sign in and sign up in one flow (like the web's `AuthPage`): the e-mail
 * first, then the one next step the server says it needs (the password, the provider the account signs
 * in with, or the name and a new password). "Esqueci a senha" happens in place. The agent reacts: eyes
 * shut while a hidden password is typed, a wink when it's shown, a frown when it's wrong. On success the
 * session gate moves to the app.
 */
/** The e-mail this phone last signed in with: the next sign-in starts with it (kept on signing out). */
export const LAST_EMAIL = "last-email";

type Step =
  | "email"
  | "password"
  | "social"
  | "noPassword"
  | "name"
  | "newPassword"
  | "closed"
  | "expired"
  | "forgot"
  | "sent";

/** Where the back button goes from each step (`null`: leave the screen, if there is somewhere to go). */
const BACK: Record<Step, Step | null> = {
  email: null,
  password: "email",
  social: "email",
  noPassword: "email",
  name: "email",
  newPassword: "name",
  closed: "email",
  expired: "email",
  forgot: "password",
  sent: "password",
};

/**
 * The steps that send something a bot could flood, and what their bot check is for (ADR 0075). The name step
 * leads to the new password's, so its token is ready by the sign-up.
 */
const STEP_ACTIONS: Partial<Record<Step, HumanAction>> = {
  email: "email-lookup",
  password: "sign-in",
  name: "sign-up",
  newPassword: "sign-up",
  forgot: "password-reset",
};

/** `access`: an early-access link's token, for the sign-up it opens (as the web's `/signup?access=`). */
export function AuthFlow({
  start,
  email: initialEmail,
  access,
}: {
  start: "in" | "up";
  email?: string;
  access?: string;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const config = useAuthConfig();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(initialEmail ?? readValueSync(LAST_EMAIL) ?? "");
  // The e-mail takes the keyboard once the launch splash has left, not under it.
  const launched = useLaunched();
  // Under an invitation's screen (a request still waiting, reopened) it stays out of the way.
  const focused = useIsFocused();
  const emailField = useRef<ComponentRef<typeof TextInput>>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState(false);
  const [wink, setWink] = useState(false);
  const human = useHumanCheck(STEP_ACTIONS[step] ?? null);
  const linkedProviders = useSocialProviders(options?.providers);
  const allProviders = useSocialProviders();
  const canReset = config.data?.passwordReset === true;
  const requests = earlyAccessRequests(access);
  // Where this sign-in leads, in place of the general line: the invitation opened before it (its workspace, by its
  // token), as the web's sign-in says it.
  const [waiting] = useState(pendingInvite);
  const invitation = useQuery({ ...invitationQuery(api, waiting?.token ?? ""), enabled: waiting !== null });
  const goal = signInPurpose(invitation.data);
  const purpose = goal ? t(goal.key, { org: goal.org }) : null;
  const termsUrl = config.data?.termsUrl;
  const privacyUrl = config.data?.privacyUrl;

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
      const found = await withHumanCheck(human.check, (token) =>
        api.account.signInOptions(requests.lookUp(value.trim()), token),
      );
      setOptions(found);
      setPassword("");
      // No password and no provider this server signs in with (the owner's account made by the desktop
      // app): the web's "noPassword" step says where to add one, instead of an empty provider list.
      const on = config.data?.socialProviders as Partial<Record<string, boolean>> | undefined;
      const usable = found.providers.some((p) => on?.[p] === true);
      go(lookUpStep(found, usable));
    } catch (e) {
      if (!(e instanceof CheckCancelled)) setError(lookUpFailureText(t, e));
    } finally {
      setPending(false);
    }
  };

  // Came with the e-mail ("Criar conta" from somewhere that knew it): straight to the next step, once the server
  // has said whether a bot check guards it.
  const lookedUp = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the e-mail it came with
  useEffect(() => {
    if (lookedUp.current || config.isPending) return;
    lookedUp.current = true;
    if (initialEmail && isEmail(initialEmail)) void lookUp(initialEmail);
  }, [config.isPending]);

  // Mounted under the launch splash: the keyboard comes up once the splash leaves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the splash leaves or the screen comes back
  useEffect(() => {
    if (launched && focused && step === "email" && !initialEmail) emailField.current?.focus();
  }, [launched, focused]);

  /** A provider refused: its words, and the address an unconfirmed account's refusal was for, in the field. */
  const socialRefused = (text: string, address?: string) => {
    setError(text);
    if (address && text === t("auth.unconfirmed")) setEmail(address);
  };

  /** Better Auth's refusal → the sentence to show (never the server's raw text). */
  const failed = (refusal: { status: number; code?: string }) =>
    setError(refusal.status ? refusalText(t, refusal) : t("mobile.auth.errors.network"));

  /**
   * What a throw means: only a request that never got an answer (fetch's "Network request failed") is
   * "Sem conexão"; anything else in the app (the Keychain, a bug) reads as the generic failure. A bot check
   * closed with Cancel says nothing: the button is there to press again.
   */
  const thrown = (error: unknown) => {
    if (error instanceof CheckCancelled) return;
    const network = error instanceof TypeError && /network|fetch/i.test(error.message);
    if (!network) console.warn("[auth]", error);
    setError(t(network ? "mobile.auth.errors.network" : "mobile.auth.errors.generic"));
  };

  const signIn = async () => {
    setPending(true);
    setError(null);
    try {
      const refused = await withHumanCheck(human.check, async (token) =>
        refusalOf(
          await authClient().signIn.email({
            email: email.trim(),
            password,
            fetchOptions: { headers: humanCheckHeaders(token) },
          }),
        ),
      );
      if (refused) {
        haptics.warning();
        if (refused.status === 401) {
          setWrong(true);
          // The wrong password goes, so the next try starts on an empty field.
          setPassword("");
        } else failed(refused);
        return;
      }
      haptics.success();
      rememberSignIn("email");
      void writeValue(LAST_EMAIL, email.trim());
    } catch (error) {
      thrown(error);
    } finally {
      setPending(false);
    }
  };

  const signUp = async () => {
    setPending(true);
    setError(null);
    try {
      const refused = await withHumanCheck(human.check, async (token) =>
        refusalOf(
          await authClient().signUp.email({
            name: name.trim(),
            email: email.trim(),
            password,
            fetchOptions: { headers: { ...humanCheckHeaders(token), ...requests.headers } },
          }),
        ),
      );
      if (refused) {
        haptics.warning();
        // Checked by code: the bot check refuses with a 403 too, and that isn't sign-up being closed.
        if (signUpClosed(refused)) go("closed");
        else failed(refused);
        return;
      }
      haptics.success();
      rememberSignIn("email");
      void writeValue(LAST_EMAIL, email.trim());
      // A server that sends email sent this address a link to confirm it: the first run says where it went.
      if (canReset) rememberConfirmationSent(email);
    } catch (error) {
      thrown(error);
    } finally {
      setPending(false);
    }
  };

  const sendReset = async () => {
    setPending(true);
    setError(null);
    try {
      // The answer is the same whether or not the account exists. Relative: the server resolves it
      // against its own address, so the link opens its web page whatever address the app reached it at.
      const refused = await withHumanCheck(human.check, async (token) =>
        refusalOf(
          await authClient().requestPasswordReset({
            email: email.trim(),
            redirectTo: "/reset-password",
            fetchOptions: { headers: humanCheckHeaders(token) },
          }),
        ),
      );
      if (refused) return failed(refused);
      haptics.success();
      go("sent");
    } catch (error) {
      thrown(error);
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
  // Steps without a subtitle: their field and buttons say it (the new password's meter gives the minimum).
  const bubble: Record<Step, [string, string?]> = {
    email: start === "up" ? [t("auth.flow.emailUp")] : [t("auth.flow.email"), purpose ?? t("auth.flow.emailLead")],
    password: wrong ? [t("auth.flow.wrong")] : [t("auth.flow.password"), purpose ?? t("auth.flow.passwordLead")],
    social: [t("auth.flow.social", { providers: providerNames }), t("auth.flow.socialLead")],
    noPassword: [t("auth.flow.noPassword"), t("auth.flow.noPasswordLead")],
    name: [t("auth.flow.name"), t("auth.flow.nameLead")],
    newPassword: [first ? t("auth.flow.newPasswordNamed", { name: first }) : t("auth.flow.newPassword")],
    closed: [t("auth.flow.closed"), t("auth.flow.closedLead")],
    expired: [
      t("auth.flow.expired"),
      config.data?.supportEmail
        ? t("auth.flow.expiredLead", { email: config.data.supportEmail })
        : t("auth.flow.expiredLeadAsk"),
    ],
    forgot: [t("auth.flow.forgot"), t("auth.flow.forgotLead")],
    sent: [t("auth.flow.sent", { email: email.trim() }), t("auth.flow.sentLead")],
  };
  const [title, lead] = bubble[step];

  const backTo = step === "forgot" && !options?.password ? "email" : BACK[step];
  const onBack = backTo ? () => go(backTo) : router.canGoBack() ? () => router.back() : undefined;

  const fix = step === "email" || step === "forgot" ? emailTypoFix(email) : null;
  const mail = webmailOf(email);

  const terms =
    (step === "email" || step === "newPassword") && termsUrl && privacyUrl ? (
      <Terms termsUrl={termsUrl} privacyUrl={privacyUrl} />
    ) : null;

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
      overlay={human.view}
      footer={
        step === "email" ? (
          <View style={{ gap: 14, alignItems: "center" }}>
            {terms}
            <ServerLine />
          </View>
        ) : (
          terms
        )
      }
    >
      {step !== "email" && step !== "forgot" && step !== "sent" ? (
        // Where the e-mail can't sign up, "Usar outro e-mail" below already changes it: the chip only says which.
        <Who
          email={email.trim()}
          onChange={step === "closed" || step === "expired" || step === "noPassword" ? undefined : () => go("email")}
        />
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
            ref={emailField}
            autoFocus={!initialEmail && launched && focused}
          />
          {fix ? (
            <Pressable
              onPress={() => setEmail(fix)}
              accessibilityRole="button"
              hitSlop={6}
              style={{ alignSelf: "center" }}
            >
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
        <Text tone="danger" variant="small" accessibilityLiveRegion="polite" style={CENTER}>
          {error}
        </Text>
      ) : null}

      {/* A provider refused an unconfirmed account: a new password by email, never a new confirmation (ADR 0006). */}
      {canReset && error === t("auth.unconfirmed") && isEmail(email) ? (
        <Quiet label={t("auth.unconfirmedReset")} onPress={() => go("forgot")} />
      ) : null}

      {submitLabel[step] ? (
        <Button variant="primary" wide label={submitLabel[step]} disabled={!ready || pending} onPress={submit} />
      ) : null}

      {step === "email" ? (
        <SocialButtons providers={allProviders} onError={socialRefused} earlyAccess={access} />
      ) : null}

      {step === "password" && canReset ? <Quiet label={t("auth.forgotPassword")} onPress={() => go("forgot")} /> : null}

      {step === "social" ? (
        <>
          <SocialButtons providers={linkedProviders} divider={false} onError={setError} />
          {canReset ? <Quiet label={t("auth.flow.createPassword")} onPress={() => go("forgot")} /> : null}
        </>
      ) : null}

      {step === "closed" || step === "expired" || step === "noPassword" ? (
        <Button variant="secondary" wide label={t("auth.flow.otherEmail")} onPress={() => go("email")} />
      ) : null}

      {step === "noPassword" && canReset ? (
        <Quiet label={t("auth.flow.createPassword")} onPress={() => go("forgot")} />
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
function Who({ email, onChange }: { email: string; onChange?: () => void }) {
  const { t } = useTranslation();
  const { colors, shadows } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        alignSelf: "center",
        maxWidth: "100%",
        minHeight: 32,
        paddingLeft: 10,
        paddingRight: onChange ? 4 : 10,
        borderRadius: 10,
        backgroundColor: colors.raised,
        boxShadow: shadows.e1,
      }}
    >
      <Icon name="mail" size={16} color={colors.muted} />
      <Text variant="subhead" numberOfLines={1} style={{ flexShrink: 1 }}>
        {email}
      </Text>
      {onChange ? (
        <Pressable onPress={onChange} accessibilityRole="button" hitSlop={8} style={{ paddingHorizontal: 8 }}>
          <Text variant="subhead" style={{ fontWeight: "600" }}>
            {t("auth.flow.change")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A quiet text link under the main answer ("Esqueci a senha"). */
export function Quiet({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <View style={{ alignItems: "center", marginTop: 4 }}>
      <AuthLink label={label} onPress={onPress} />
    </View>
  );
}

/** "Ao continuar, você aceita os Termos e a Política de privacidade." */
export function Terms({ termsUrl, privacyUrl }: { termsUrl: string; privacyUrl: string }) {
  const { t } = useTranslation();
  const link = (label: string, url: string): ReactNode => (
    <Text
      variant="caption"
      tone="muted"
      style={{ textDecorationLine: "underline" }}
      // In a sheet over the app (Safari's view), not out to Safari: the sign-up stays where it was.
      onPress={() => void openBrowserAsync(url).catch(() => Linking.openURL(url))}
    >
      {label}
    </Text>
  );
  return (
    <Text variant="caption" tone="muted" style={{ textAlign: "center" }}>
      {t("auth.termsBefore")}
      {link(t("auth.terms"), termsUrl)}
      {t("auth.termsMiddle")}
      {link(t("auth.privacy"), privacyUrl)}
      {t("auth.termsAfter")}
    </Text>
  );
}
