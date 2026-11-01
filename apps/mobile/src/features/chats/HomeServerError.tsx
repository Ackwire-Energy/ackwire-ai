import { checkServer, isTailnet, type ServerCheck, serverHost } from "@agenteschat/client/lib/server";
import { useNetworkState } from "expo-network";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { Button, EmptyState, LineIcon, Text } from "@/ui";
import { problemText } from "../server";
import { useColors } from "../shared/hooks";
import { useSurface } from "../shared/parts";

/** While Conversas can't reach the server, it asks again this often (it fills in on its own when it answers). */
const RETRY_EVERY_MS = 15_000;

/**
 * Why Conversas can't load, in the person's words: no internet on the phone, or the server's own check (`GET
 * /api/instance`: Tailscale, a certificate, a version), or plainly "didn't answer". Mounted only while it fails.
 */
function useServerTrouble(retry: () => Promise<unknown>) {
  const { t } = useTranslation();
  const network = useNetworkState();
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [checking, setChecking] = useState(false);

  const latest = useRef(retry);
  latest.current = retry;

  useEffect(() => {
    let alive = true;
    void checkServer(serverUrl()).then((c) => {
      if (alive) setCheck(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => void latest.current(), RETRY_EVERY_MS);
    return () => clearInterval(timer);
  }, []);

  const server = check?.server ?? serverUrl();
  const host = serverHost(server);
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const problem = check && !check.ok ? check.problem : "unreachable";
  // Off a tailnet, "unreachable" is a server that worked before: down, not a wrong address.
  const plain = !offline && problem === "unreachable" && !isTailnet(server);
  const title = offline
    ? t("mobile.chats.serverError.offline")
    : plain
      ? t("mobile.auth.server.down.line", { host })
      : t(problemText(problem, server), { host });
  const again = () => {
    setChecking(true);
    void Promise.allSettled([checkServer(serverUrl()).then(setCheck), retry()]).then(() => setChecking(false));
  };
  return { title, plain, checking, again };
}

/**
 * Conversas when its list failed to load with nothing kept on the phone: what is wrong (no internet, the server
 * didn't answer, or why its check says it can't be used), "Tentar de novo", and it tries on its own meanwhile.
 * Without this a failed load read as an empty workspace and invited the first agent.
 */
export function HomeServerError({ retry }: { retry: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const trouble = useServerTrouble(retry);
  return (
    <View style={styles.full} accessibilityLiveRegion="polite">
      <EmptyState
        icon="wifi"
        title={trouble.title}
        subtitle={trouble.plain ? t("mobile.chats.serverError.text") : undefined}
        action={
          <Button
            variant="primary"
            size="sm"
            icon="undo"
            label={trouble.checking ? t("mobile.auth.server.checking") : t("mobile.common.retry")}
            disabled={trouble.checking}
            onPress={trouble.again}
          />
        }
      />
    </View>
  );
}

/**
 * Over Conversas' kept rows when loading them again failed: a neutral card (the color only on its icon), the
 * same words as the full state and "Tentar de novo"; it goes once a load works.
 */
export function HomeServerNotice({ retry }: { retry: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const trouble = useServerTrouble(retry);
  return (
    <View style={styles.list}>
      <View style={[styles.card, surface]} accessibilityLiveRegion="polite">
        <View style={styles.line} accessible accessibilityRole="summary">
          <LineIcon name="wifi" variant="callout" size={22} color={c.amber} />
          <View style={styles.tx}>
            <Text variant="callout" tone="ink" style={styles.bold} numberOfLines={3}>
              {trouble.title}
            </Text>
            <Text variant="small" tone="muted" numberOfLines={2}>
              {t("mobile.chats.serverError.kept")}
            </Text>
          </View>
        </View>
        <Button
          variant="secondary"
          size="sm"
          wide
          label={trouble.checking ? t("mobile.auth.server.checking") : t("mobile.common.retry")}
          disabled={trouble.checking}
          onPress={trouble.again}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { paddingTop: 48, paddingHorizontal: 24 },
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  card: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  tx: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
