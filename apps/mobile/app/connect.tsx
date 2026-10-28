import { checkServer, normalizeServer, type ServerCheck, serverHost } from "@agenteschat/client/lib/server";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { connectToServer, problemText } from "@/features/server";
import { ALLOW_HTTP, serverUrl } from "@/lib/server";
import { connectPlan } from "@/lib/server-choice";
import { useSession } from "@/providers/session";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Text } from "@/ui/Text";

/** How long the token's session gets to arrive before the screen says so (never a screen that waits forever). */
const SIGN_IN_WAIT_MS = 15_000;

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
  const [slow, setSlow] = useState(false);

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
  useEffect(() => {
    if (!signingIn || session.signedIn) return;
    const timer = setTimeout(() => {
      haptics.warning();
      setSlow(true);
    }, SIGN_IN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [signingIn, session.signedIn]);

  const leave = () => router.replace(session.signedIn ? "/" : "/sign-in");

  if (!server)
    return (
      <AuthScaffold title={t("mobile.auth.connect.notALink")} onBack={leave}>
        <Button variant="primary" wide label={t("mobile.common.back")} onPress={leave} />
      </AuthScaffold>
    );

  const target = check?.server ?? server;
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
    router.replace(plan.move || !session.signedIn ? "/sign-in" : "/");
  };

  const problem = check && !check.ok ? t(problemText(check.problem, target), { host: serverHost(target) }) : null;
  // The token was refused, or its session never arrived: on to signing in with the email.
  const stuck = refused || slow;
  return (
    <AuthScaffold
      // The question is the title; the address a line under it (a long host broke mid-word in large type).
      title={t(token ? "mobile.auth.connect.titleSignIn" : "mobile.auth.connect.title")}
      subtitle={t("mobile.auth.connect.on", { host: serverHost(target) })}
      onBack={leave}
    >
      {plan.signOut && !stuck ? (
        <Text tone="muted" variant="small" style={CENTER}>
          {t("mobile.auth.connect.leave")}
        </Text>
      ) : null}
      {stuck || problem ? (
        <Text tone="danger" variant="small" style={CENTER}>
          {refused ? t("mobile.auth.connect.tokenFailed") : slow ? t("mobile.auth.connect.signInSlow") : problem}
        </Text>
      ) : null}
      {stuck ? (
        <Button variant="primary" wide label={t("mobile.common.continue")} onPress={() => router.replace("/sign-in")} />
      ) : problem ? (
        <Button variant="primary" wide label={t("mobile.common.retry")} onPress={() => setAttempt((a) => a + 1)} />
      ) : (
        <Button
          variant="primary"
          wide
          label={check ? t("mobile.auth.connect.confirm") : t("mobile.auth.connect.checking")}
          loading={!check || busy}
          onPress={() => void confirm()}
        />
      )}
      {stuck ? null : <Button variant="ghost" wide label={t("mobile.common.cancel")} onPress={leave} />}
    </AuthScaffold>
  );
}
