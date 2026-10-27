import { useCompleteOAuth } from "@agenteschat/client";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useToast } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { errorHaptic, successHaptic } from "../shared/parts";
import { isFinishing } from "./logic";

/**
 * A connector's sign-in that came back to the app through its link (Android opens the app with it; iOS hands
 * it to the open sheet). When the sheet that started it is still finishing, this screen just steps aside;
 * otherwise (the app was closed meanwhile) it finishes here and lands on Conectores.
 */
export function ConnectorOAuthReturn() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const complete = useCompleteOAuth(orgId);
  const { state, code, error } = useLocalSearchParams<{ state?: string; code?: string; error?: string }>();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const leave = () => (router.canGoBack() ? router.back() : router.replace("/connectors"));
    if (state && isFinishing(state)) return leave();
    if (error || !state || !code) {
      errorHaptic();
      toast({ title: t("mobile.connectors.failed"), icon: "x" });
      return void router.replace("/connectors");
    }
    complete.mutate(
      { state, code },
      {
        onSettled: (_data, failed) => {
          if (failed) {
            errorHaptic();
            toast({ title: t("mobile.connectors.failed"), icon: "x" });
          } else {
            successHaptic();
            toast({ title: t("mobile.connectors.connectedDone") });
          }
          router.replace("/connectors");
        },
      },
    );
  }, [state, code, error, complete, toast, t]);
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center" },
});
