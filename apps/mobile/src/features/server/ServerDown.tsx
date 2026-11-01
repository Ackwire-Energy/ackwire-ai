import {
  checkServer,
  isTailnet,
  type ServerCheck,
  type ServerProblem,
  serverHost,
} from "@agenteschat/client/lib/server";
import { useNetworkState } from "expo-network";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { signOut } from "@/features/account";
import { SERVER_GIVE_UP_MS, SERVER_STUCK_MS, serverDownOf } from "@/lib/org-choice";
import { serverUrl } from "@/lib/server";
import { useOrgGate } from "@/providers/org";
import { AuthLink } from "@/ui/auth/AuthLink";
import { CENTER } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { problemText } from "./index";

/** While it waits, the account is asked for again this often (the app opens on its own once it answers). */
const RETRY_EVERY_MS = 15_000;

export interface ServerDown {
  problem: ServerProblem;
  /** The address that failed (a server's own address can differ from the one saved). */
  server: string;
  checking: boolean;
  retry: () => void;
}

/**
 * Whether the server the app is signed in to can't be opened (`serverDownOf`): the account failed to load with
 * nothing cached, or it is still loading after `SERVER_STUCK_MS` and the server doesn't answer. Without this a
 * failed load read as "no organization" and opened the first run. Past `SERVER_GIVE_UP_MS` it counts as failed
 * whatever the server says, and from `SERVER_STUCK_MS` on the account is asked for again, which replaces a request
 * that hung: nobody waits on a screen with no way out. `active`: signed in, the session read.
 */
export function useServerDown(active: boolean): ServerDown | null {
  const org = useOrgGate();
  const [stuck, setStuck] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [checking, setChecking] = useState(false);

  const waiting = active && org.loading;
  useEffect(() => {
    setStuck(false);
    setGaveUp(false);
    if (!waiting) return;
    const asks = setTimeout(() => setStuck(true), SERVER_STUCK_MS);
    const ends = setTimeout(() => setGaveUp(true), SERVER_GIVE_UP_MS);
    return () => {
      clearTimeout(asks);
      clearTimeout(ends);
    };
  }, [waiting]);

  // Asks the server itself once something looks wrong: its answer says why (Tailscale, a certificate, a version).
  const asking = active && (org.unreachable || stuck);
  useEffect(() => {
    setCheck(null);
    if (!asking) return;
    let alive = true;
    void checkServer(serverUrl()).then((c) => {
      if (alive) setCheck(c);
    });
    return () => {
      alive = false;
    };
  }, [asking]);

  const problem = active ? serverDownOf(org.unreachable || gaveUp, stuck, check) : null;
  const orgRetry = org.retry;
  const retry = useCallback(() => {
    setChecking(true);
    void Promise.all([checkServer(serverUrl()), orgRetry()]).then(([c]) => {
      setCheck(c);
      setChecking(false);
    });
  }, [orgRetry]);

  useEffect(() => {
    if (!problem && !stuck) return;
    const timer = setInterval(() => void orgRetry(), RETRY_EVERY_MS);
    return () => clearInterval(timer);
  }, [problem, stuck, orgRetry]);

  if (!problem) return null;
  return { problem, server: check?.server ?? serverUrl(), checking, retry };
}

/**
 * Under the launch splash's name while the server doesn't answer (`LaunchSplash`'s `waiting`): what happened, with
 * the reason when the server's check found one, Tentar de novo (it also tries on its own, and when the app comes
 * back to the front) and Sair, to sign in elsewhere ("Trocar" under the sign-in).
 */
export function ServerDownPanel({ down }: { down: ServerDown }) {
  const { t } = useTranslation();
  const network = useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const host = serverHost(down.server);
  // Off a tailnet, "unreachable" here is a server that worked before: down, not a wrong address.
  const plain = !offline && down.problem === "unreachable" && !isTailnet(down.server);
  const line = offline
    ? t("mobile.auth.errors.network")
    : plain
      ? t("mobile.auth.server.down.line", { host })
      : t(problemText(down.problem, down.server), { host });
  return (
    <View style={{ gap: 10 }} accessibilityLiveRegion="polite">
      <View style={{ gap: 4, marginBottom: 8 }}>
        <Text variant="body" style={[CENTER, { fontWeight: "600" }]}>
          {line}
        </Text>
        {plain ? (
          <Text variant="subhead" style={CENTER}>
            {t("mobile.auth.server.down.text")}
          </Text>
        ) : null}
      </View>
      <Button
        variant="primary"
        wide
        label={down.checking ? t("mobile.auth.server.checking") : t("mobile.common.retry")}
        disabled={down.checking}
        onPress={down.retry}
      />
      <View style={{ paddingTop: 8 }}>
        <AuthLink label={t("mobile.org.signOut")} onPress={() => void signOut()} />
      </View>
    </View>
  );
}
