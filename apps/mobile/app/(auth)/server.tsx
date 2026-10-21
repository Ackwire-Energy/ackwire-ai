import { checkServer, normalizeServer, serverHost } from "@agenteschat/client/lib/server";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { API_URL } from "@/config";
import { connectToServer, PROBLEM_TEXT } from "@/features/server";
import { ALLOW_HTTP, serverUrl } from "@/lib/server";
import { useSession } from "@/providers/session";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Text } from "@/ui/Text";
import { useToast } from "@/ui/Toast";

/**
 * "Seu servidor": the team's own agentes.chat (a self-hosted server, usually on Tailscale), by address or by
 * the QR code the web app shows. The server is checked before anything changes.
 */
export default function Server() {
  const { t } = useTranslation();
  const toast = useToast();
  const session = useSession();
  const custom = serverUrl() !== API_URL;
  const [address, setAddress] = useState(custom ? serverHost(serverUrl()) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchTo = async (server: string) => {
    await connectToServer({ server }, session.signedIn);
    toast({ title: t("mobile.auth.server.now", { host: serverHost(server) }) });
    router.back();
  };

  const submit = async () => {
    const server = normalizeServer(address, { allowHttp: ALLOW_HTTP });
    if (!server) return setError(t("mobile.auth.server.invalid"));
    setBusy(true);
    setError(null);
    const check = await checkServer(server);
    if (check.ok) return switchTo(check.server);
    haptics.warning();
    setError(t(PROBLEM_TEXT[check.problem], { host: serverHost(server) }));
    setBusy(false);
  };

  return (
    <AuthScaffold
      title={t("mobile.auth.server.title")}
      subtitle={t("mobile.auth.server.subtitle")}
      onBack={() => router.back()}
      footer={
        custom ? (
          <AuthLink
            label={t("mobile.auth.server.backTo", { host: serverHost(API_URL) })}
            onPress={() => void switchTo(API_URL)}
          />
        ) : null
      }
    >
      <AuthField
        value={address}
        onChangeText={setAddress}
        placeholder={t("mobile.auth.server.placeholder")}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="URL"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        accessibilityLabel={t("mobile.auth.server.label")}
      />
      {error ? (
        <Text tone="danger" variant="small">
          {error}
        </Text>
      ) : null}
      <Button
        variant="primary"
        wide
        label={busy ? t("mobile.auth.server.checking") : t("mobile.auth.server.use")}
        disabled={busy || !address.trim()}
        onPress={() => void submit()}
      />
      <Button
        variant="secondary"
        wide
        icon="camera"
        label={t("mobile.auth.server.scan")}
        disabled={busy}
        onPress={() => router.push("/scan")}
      />
    </AuthScaffold>
  );
}
