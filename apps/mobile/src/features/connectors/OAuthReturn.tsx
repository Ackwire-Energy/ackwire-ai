import { type Connection, type CustomServer, keys, useCatalog, useCompleteOAuth } from "@agenteschat/client";
import { connectedItems, outcomeText } from "@agenteschat/client/lib/connected";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useOrgId } from "../shared/hooks";
import { errorHaptic, goBack, successHaptic } from "../shared/parts";
import { isFinishing } from "./logic";
import { returnHref } from "./review";

/**
 * A connector's sign-in that came back to the app through its link (Android opens the app with it; iOS hands
 * it to the open sheet). When the sheet that started it is still finishing, this screen just steps aside;
 * otherwise (the app was closed meanwhile) it finishes here and lands on Conectores, on a new account's tools
 * (a new sign-in for an account, or the same account again, lands on that account's screen).
 */
export function ConnectorOAuthReturn() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const qc = useQueryClient();
  const catalog = useCatalog();
  const complete = useCompleteOAuth(orgId);
  const { state, code, error } = useLocalSearchParams<{ state?: string; code?: string; error?: string }>();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const leave = () => goBack("/connectors");
    if (state && isFinishing(state)) return leave();
    if (error || !state || !code) {
      errorHaptic();
      toast({ title: t("mobile.connectors.failed"), icon: "x" });
      return void router.replace("/connectors");
    }
    complete.mutate(
      { state, code },
      {
        onSettled: (done, failed) => {
          if (failed || !done) {
            errorHaptic();
            toast({ title: knownErrorText(t, failed) ?? t("mobile.connectors.failed"), icon: "x" });
            return void router.replace("/connectors");
          }
          successHaptic();
          const outcome = done.outcome ?? "connected";
          // The lists were read again on the way: the account's own name.
          const item = connectedItems(
            qc.getQueryData<Connection[]>(keys.connections(orgId)) ?? [],
            qc.getQueryData<CustomServer[]>(keys.customServers(orgId)) ?? [],
            catalog.data?.connectors ?? [],
          ).find((i) => i.id === done.connectionId);
          toast({ title: item ? outcomeText(t, outcome, item) : t("mobile.connectors.connectedDone") });
          // A new account on its tools, as the web lands on "O que faz" for the connection that came in.
          if (outcome === "connected") router.replace(returnHref(done.connectionId));
          else router.replace(`/connectors/${done.connectionId}`);
        },
      },
    );
  }, [state, code, error, complete, toast, t, qc, orgId, catalog.data]);
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center" },
});
