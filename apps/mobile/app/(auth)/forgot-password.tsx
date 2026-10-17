import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { API_URL } from "@/config";
import { authClient } from "@/lib/auth";
import { isEmail } from "@/lib/validate";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";

/** Forgot the password: the email, then "check your email" (the link opens the website). */
export default function ForgotPassword() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(typeof params.email === "string" ? params.email : "");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!isEmail(email)) return setError(t("mobile.auth.email.invalid"));
    setBusy(true);
    setError(null);
    try {
      // The answer is the same whether or not the account exists (no account discovery).
      await authClient.requestPasswordReset({ email: email.trim(), redirectTo: `${API_URL}/reset-password` });
      setSent(true);
    } catch {
      setError(t("mobile.auth.errors.network"));
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <AuthScaffold
        title={t("mobile.auth.forgot.sentTitle")}
        subtitle={t("mobile.auth.forgot.sentSubtitle", { email: email.trim() })}
        onBack={() => router.back()}
      >
        <Button
          variant="primary"
          wide
          label={t("mobile.auth.forgot.backToSignIn")}
          onPress={() => router.replace("/sign-in")}
        />
      </AuthScaffold>
    );

  return (
    <AuthScaffold
      title={t("mobile.auth.forgot.title")}
      subtitle={t("mobile.auth.forgot.subtitle")}
      onBack={() => router.back()}
      footer={<AuthLink label={t("mobile.auth.forgot.backToSignIn")} onPress={() => router.back()} />}
    >
      <AuthField
        value={email}
        onChangeText={setEmail}
        placeholder={t("mobile.auth.email.placeholder")}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        returnKeyType="send"
        onSubmitEditing={() => void send()}
        accessibilityLabel={t("mobile.auth.email.title")}
      />
      {error ? (
        <Text tone="danger" variant="small">
          {error}
        </Text>
      ) : null}
      <Button
        variant="primary"
        wide
        label={t("mobile.auth.forgot.submit")}
        disabled={busy}
        onPress={() => void send()}
      />
    </AuthScaffold>
  );
}
