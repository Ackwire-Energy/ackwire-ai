import { checkServer, normalizeServer, type ServerCheck, serverHost } from "@agenteschat/client/lib/server";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { connectToServer, PROBLEM_TEXT } from "@/features/server";
import { ALLOW_HTTP, serverUrl } from "@/lib/server";
import { connectPlan } from "@/lib/server-choice";
import { useSession } from "@/providers/session";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Text } from "@/ui/Text";

/**
 * A connect link, `agenteschat://connect?server=…[&token=…]` (the web app's QR code, the self-host setup):
 * the server is checked and shown in large type, and nothing changes until the person confirms, so a QR
 * code never points the app somewhere else on its own. With a token, the app lands signed in.
 */
export default function Connect() {
  const { t } = useTranslation();
  const session = useSession();
  const params = useLocalSearchParams<{ server?: string; token?: string }>();
  const server = normalizeServer(typeof params.server === "string" ? params.server : "", { allowHttp: ALLOW_HTTP });
  const token = typeof params.token === "string" && params.token ? params.token : undefined;
  const [attempt, setAttempt] = useState(0);
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again (Tentar de novo)
  useEffect(() => {
    if (!server) return;
    let alive = true;
    setCheck(null);
    void checkServer(server).then((c) => {
      if (alive) setCheck(c);
    });
    return () => {
      alive = false;
    };
  }, [server, attempt]);

  // The token's session arrives a moment after the answer: into the app once it has.
  useEffect(() => {
    if (signingIn && session.signedIn) router.replace("/");
  }, [signingIn, session.signedIn]);

  const leave = () => router.replace(session.signedIn ? "/" : "/sign-in");

  if (!server)
    return (
      <AuthScaffold title={t("mobile.auth.connect.notALink")} onBack={leave}>
        <Button variant="primary" wide label={t("mobile.common.back")} onPress={leave} />
      </AuthScaffold>
    );

  const target = check?.server ?? server;
  const moving = target !== serverUrl();
  const plan = connectPlan(serverUrl(), session.signedIn, { server: target, token });

  const confirm = async () => {
    if (!check?.ok) return;
    setBusy(true);
    const ok = await connectToServer({ server: check.server, token }, session.signedIn);
    if (token && ok) return setSigningIn(true);
    if (token) {
      haptics.warning();
      setBusy(false);
      return setRefused(true);
    }
    router.replace(moving || !session.signedIn ? "/sign-in" : "/");
  };

  const problem = check && !check.ok ? t(PROBLEM_TEXT[check.problem], { host: serverHost(target) }) : null;
  return (
    <AuthScaffold
      title={serverHost(target)}
      subtitle={t(token ? "mobile.auth.connect.questionSignIn" : "mobile.auth.connect.question")}
      onBack={leave}
    >
      {session.signedIn && plan.signOut && !refused ? (
        <Text tone="muted" variant="small">
          {t("mobile.auth.connect.leave")}
        </Text>
      ) : null}
      {refused || problem ? (
        <Text tone="danger" variant="small">
          {refused ? t("mobile.auth.connect.tokenFailed") : problem}
        </Text>
      ) : null}
      {refused ? (
        <Button variant="primary" wide label={t("mobile.common.continue")} onPress={() => router.replace("/sign-in")} />
      ) : problem ? (
        <Button variant="primary" wide label={t("mobile.common.retry")} onPress={() => setAttempt((a) => a + 1)} />
      ) : (
        <Button
          variant="primary"
          wide
          label={check ? t("mobile.auth.connect.confirm") : t("mobile.auth.connect.checking")}
          disabled={!check || busy}
          onPress={() => void confirm()}
        />
      )}
      {refused ? null : <Button variant="ghost" wide label={t("mobile.common.cancel")} onPress={leave} />}
    </AuthScaffold>
  );
}
