import { useAuthConfig } from "@agenteschat/client";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "@/lib/auth";
import { authErrorKey, isEmail, MIN_PASSWORD } from "@/lib/validate";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { SocialButtons } from "@/ui/auth/SocialButtons";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Text } from "@/ui/Text";

type Step = "name" | "email" | "password";
const ORDER: Step[] = ["name", "email", "password"];

/** Create an account: name, email, password, one per screen. */
export default function SignUp() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ email?: string }>();
  const config = useAuthConfig();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(typeof params.email === "string" ? params.email : "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const closed = config.data?.signupOpen === false;
  const back = () => {
    setError(null);
    const i = ORDER.indexOf(step);
    if (i > 0) setStep(ORDER[i - 1] as Step);
    else router.back();
  };
  const signInLink = (
    <AuthLink
      lead={t("mobile.auth.signUp.haveAccount")}
      label={t("mobile.auth.signUp.signIn")}
      onPress={() => router.replace("/sign-in")}
    />
  );

  const submit = async () => {
    if (password.length < MIN_PASSWORD) return setError(t("mobile.auth.signUp.tooShort"));
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signUp.email({ name: name.trim(), email: email.trim(), password });
      if (res.error) {
        haptics.warning();
        setError(t(authErrorKey(res.error, "signUp")));
      }
    } catch {
      setError(t("mobile.auth.errors.network"));
    } finally {
      setBusy(false);
    }
  };

  if (closed)
    return (
      <AuthScaffold
        title={t("mobile.auth.signUp.submit")}
        subtitle={t("mobile.auth.signUp.closed")}
        onBack={back}
        footer={signInLink}
      />
    );

  if (step === "name")
    return (
      <AuthScaffold
        title={t("mobile.auth.signUp.nameTitle")}
        subtitle={t("mobile.auth.signUp.nameSubtitle")}
        onBack={back}
        footer={signInLink}
      >
        <AuthField
          value={name}
          onChangeText={setName}
          placeholder={t("mobile.auth.signUp.namePlaceholder")}
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          onSubmitEditing={() => name.trim() && setStep("email")}
          accessibilityLabel={t("mobile.auth.signUp.nameTitle")}
        />
        <Button
          variant="primary"
          wide
          label={t("mobile.common.continue")}
          disabled={!name.trim()}
          onPress={() => setStep("email")}
        />
        <SocialButtons onError={setError} />
        {error ? (
          <Text tone="danger" variant="small">
            {error}
          </Text>
        ) : null}
      </AuthScaffold>
    );

  if (step === "email") {
    const next = () => {
      if (!isEmail(email)) return setError(t("mobile.auth.email.invalid"));
      setError(null);
      setStep("password");
    };
    return (
      <AuthScaffold title={t("mobile.auth.email.title")} subtitle={t("mobile.auth.email.subtitle")} onBack={back}>
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
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold
      title={t("mobile.auth.signUp.passwordTitle")}
      subtitle={t("mobile.auth.signUp.passwordSubtitle")}
      onBack={back}
    >
      <AuthField
        value={password}
        onChangeText={setPassword}
        placeholder={t("mobile.auth.signUp.passwordPlaceholder")}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        accessibilityLabel={t("mobile.auth.signUp.passwordTitle")}
      />
      {error ? (
        <Text tone="danger" variant="small">
          {error}
        </Text>
      ) : null}
      <Button
        variant="primary"
        wide
        label={t("mobile.auth.signUp.submit")}
        disabled={busy}
        onPress={() => void submit()}
      />
    </AuthScaffold>
  );
}
