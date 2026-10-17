import { useAuthConfig } from "@agenteschat/client";
import { router } from "expo-router";
import { type ComponentRef, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TextInput } from "react-native";
import { authClient } from "@/lib/auth";
import { authErrorKey, isEmail } from "@/lib/validate";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { SocialButtons } from "@/ui/auth/SocialButtons";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Text } from "@/ui/Text";

/** Sign in: the email first, then the password (one question per screen). */
export default function SignIn() {
  const { t } = useTranslation();
  const config = useAuthConfig();
  const [step, setStep] = useState<"email" | "password">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<ComponentRef<typeof TextInput>>(null);

  const next = () => {
    if (!isEmail(email)) return setError(t("mobile.auth.email.invalid"));
    setError(null);
    setStep("password");
    setTimeout(() => passwordRef.current?.focus(), 250);
  };

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signIn.email({ email: email.trim(), password });
      if (res.error) {
        haptics.warning();
        setError(t(authErrorKey(res.error, "signIn")));
      }
      // On success the session gate moves to the app.
    } catch {
      setError(t("mobile.auth.errors.network"));
    } finally {
      setBusy(false);
    }
  };

  const footer =
    config.data?.signupOpen !== false ? (
      <AuthLink
        lead={t("mobile.auth.signIn.noAccount")}
        label={t("mobile.auth.signIn.createAccount")}
        onPress={() => router.push({ pathname: "/sign-up", params: email ? { email } : {} })}
      />
    ) : null;

  if (step === "email")
    return (
      <AuthScaffold title={t("mobile.auth.email.title")} subtitle={t("mobile.auth.email.subtitle")} footer={footer}>
        <AuthField
          value={email}
          onChangeText={setEmail}
          placeholder={t("mobile.auth.email.placeholder")}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          returnKeyType="next"
          onSubmitEditing={next}
          accessibilityLabel={t("mobile.auth.email.title")}
        />
        {error ? (
          <Text tone="danger" variant="small">
            {error}
          </Text>
        ) : null}
        <Button variant="primary" wide label={t("mobile.common.continue")} onPress={next} />
        <SocialButtons onError={setError} />
      </AuthScaffold>
    );

  return (
    <AuthScaffold
      title={t("mobile.auth.signIn.passwordTitle")}
      subtitle={t("mobile.auth.signIn.passwordSubtitle", { email: email.trim() })}
      onBack={() => {
        setError(null);
        setStep("email");
      }}
      footer={
        <AuthLink
          label={t("mobile.auth.signIn.forgot")}
          onPress={() => router.push({ pathname: "/forgot-password", params: { email: email.trim() } })}
        />
      }
    >
      <AuthField
        ref={passwordRef}
        value={password}
        onChangeText={setPassword}
        placeholder={t("mobile.auth.signIn.passwordPlaceholder")}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        accessibilityLabel={t("mobile.auth.signIn.passwordTitle")}
      />
      {error ? (
        <Text tone="danger" variant="small">
          {error}
        </Text>
      ) : null}
      <Button
        variant="primary"
        wide
        label={t("mobile.auth.signIn.submit")}
        disabled={busy || !password}
        onPress={() => void submit()}
      />
    </AuthScaffold>
  );
}
