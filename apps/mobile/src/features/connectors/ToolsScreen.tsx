import { useCatalog, useConnections, useCustomServers } from "@agenteschat/client";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader } from "../shared/parts";
import { ReviewStep } from "./ToolReview";

/** Opens a connection's Ferramentas (from its sheet, or the gallery when its tools wait for a review). */
export const openTools = (id: string) => router.push({ pathname: "/connectors/tools", params: { id } });

/**
 * Ferramentas, a screen pushed over Conectores (the web's "Ferramentas", "Revisar" while some wait): what each of a
 * connection's tools may do on its own, grouped by level, under the native bar with its back button. A server's are
 * changed here and saved with Salvar, which goes back; our catalog services' are shown as they are.
 */
export function ToolsScreen({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const item = connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
    (i) => i.id === connectionId,
  );
  const name = item ? itemName(t, item) : "";
  // Until the connection is known, a catalog one can't tell its tools yet (it would read as none).
  const loading = !item && (catalog.isPending || connections.isPending || servers.isPending);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("connectors.tools")} {...(name ? { subtitle: name } : {})} solid={false} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}
      >
        {loading ? (
          <ActivityIndicator color={c.muted} />
        ) : (
          <ReviewStep connectionId={connectionId} def={item?.def ?? null} name={name} onNext={goBack} onScreen />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // The phone's settings: groups on the grouped gray, the save button after them.
  page: { paddingHorizontal: 16, paddingTop: 8, gap: 14 },
});
