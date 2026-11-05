import { useCatalog, useConnections, useCustomServers, useRenameConnection } from "@agenteschat/client";
import {
  accountUnchecked,
  type ConnectedItem,
  connectedItems,
  itemName,
  reconnectAddsText,
} from "@agenteschat/client/lib/connected";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorBrand } from "@agenteschat/client/lib/scopes";
import { router } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Dither } from "@/sky/Dither";
import { Button, fieldText, Text, useToast } from "@/ui";
import { CoverBarBackdrop, CoverParallax, useCoverScroll } from "@/ui/cover";
import { useColors, useOrgId } from "../shared/hooks";
import { ActionList, errorHaptic, goBack, PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { ConnectorIcon } from "./ConnectorIcon";
import { AddressSheet, AgentLevels, ConnectSheet, DisconnectButton, SafeNote } from "./ConnectSheet";
import { accountActions, brandOf, brandTones } from "./logic";
import { Problem } from "./Problem";
import { ToolsRow } from "./ToolReview";
import { openTools } from "./ToolsScreen";

/** Opens a connection's own screen (from its tile or its icon in Conectores). */
export const openConnection = (id: string) => router.push(`/connectors/${id}`);

/**
 * A connection, a screen pushed over Conectores: its brand's pixel sky behind the native clear bar (lagging behind
 * the scroll, as an agent's page), its icon with the check, its name and account; who uses it and how far (one
 * choice per agent), what always asks, its tools (Ferramentas, a screen of their own; "Revisar" while some wait),
 * the account itself (Renomear, Reconectar, another account of an MCP server, each in a sheet) and disconnecting
 * it. Connecting a new service stays in its sheet.
 */
export function ConnectionScreen({ id }: { id: string }) {
  return (
    <SheetHostProvider>
      <Connection id={id} />
    </SheetHostProvider>
  );
}

function Connection({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { org } = useOrg();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const admin = can(org, "manage_connectors");
  const sheet = useSheet();
  const { y, onScroll } = useCoverScroll();
  const item = connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
    (i) => i.id === id,
  );
  const loading = !item && (catalog.isPending || connections.isPending || servers.isPending);
  const name = item ? itemName(t, item) : "";
  const brand = (item?.def ? brandOf(item.def.brandColor) : null) ?? c.ink2;
  // The account when it says something the name doesn't (a server's host often is its name), else how it connects
  // through Composio (its address means nothing to people), else the category.
  const sub =
    item?.account && item.account !== name
      ? item.account
      : item?.viaComposio
        ? t("connectors.composio.via")
        : item?.def
          ? t(`connectors.category.${item.def.category}`)
          : "";
  const waiting = admin && item ? item.pending : 0;

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader plate solid={false} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}
      >
        {/* The brand's sky, reaching up behind the clear bar; not clipped, so a pull stretches it. */}
        <View style={[styles.band, { paddingTop: insets.top + 64 }]}>
          <CoverParallax y={y} style={StyleSheet.absoluteFill}>
            <Dither kind="sky" tones={brandTones(c.bg, brand)} pixel={4} fade={0.55} style={StyleSheet.absoluteFill} />
          </CoverParallax>
          <ConnectorIcon
            def={item?.def ?? null}
            image={item?.image}
            label={name || "·"}
            size={72}
            check={Boolean(item)}
          />
          <Text variant="display2" numberOfLines={2} style={styles.center}>
            {name}
          </Text>
          {sub ? (
            <Text variant="small" tone="muted" numberOfLines={1} style={styles.center}>
              {sub}
            </Text>
          ) : null}
        </View>

        {loading ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : item ? (
          <View style={styles.body}>
            <Text variant="small" tone="ink" accessibilityRole="header" style={styles.section}>
              {t("mobile.connectors.whoTitle")}
            </Text>
            {item.needsReconnect ? (
              <Problem text={t("mobile.connectors.needsReconnect", { name })} />
            ) : item.reconnectAdds.length > 0 ? (
              <Text variant="small" tone="muted">
                {reconnectAddsText(t, item)}
              </Text>
            ) : null}
            <AgentLevels connectionId={id} />
            <SafeNote />
            {admin ? <ToolsRow count={item.tools} waiting={waiting} onPress={() => openTools(id)} /> : null}
            {admin ? (
              <>
                <Text variant="small" tone="ink" accessibilityRole="header" style={styles.section}>
                  {t("mobile.connectors.accountTitle")}
                </Text>
                <ActionList
                  items={accountActions(item).map((action) =>
                    action === "rename"
                      ? {
                          key: action,
                          icon: "pen",
                          label: t("connectors.rename"),
                          onPress: () => sheet.open(<RenameSheet item={item} />),
                        }
                      : {
                          key: action,
                          icon: action === "add" ? "plus" : "bolt",
                          label: t(action === "add" ? "connectors.detail.addAccount" : "connectors.detail.reconnect"),
                          hint: t(
                            item.custom && accountUnchecked([item.server])
                              ? action === "add"
                                ? "connectFlow.newAccountUnchecked"
                                : "connectFlow.replaceUnchecked"
                              : action === "add"
                                ? "connectors.detail.accountsText"
                                : "connectors.detail.replaceText",
                          ),
                          onPress: () =>
                            sheet.open(
                              item.def ? (
                                <ConnectSheet def={item.def} item={item} mode={action} />
                              ) : (
                                <AddressSheet item={item} mode={action} />
                              ),
                            ),
                        },
                  )}
                />
                <DisconnectButton item={item} name={name} onDone={goBack} />
                {item.viaComposio ? (
                  <Text variant="small" tone="muted">
                    {t("connectors.composio.disconnectNote", {
                      name: item.def ? connectorBrand(item.def) : name,
                    })}
                  </Text>
                ) : null}
              </>
            ) : null}
          </View>
        ) : null}
      </Animated.ScrollView>
      {/* What the clear bar becomes once the page scrolls under it, as on an agent's page and Você. */}
      <CoverBarBackdrop y={y} from={0} to={12} height={headerHeight} />
    </View>
  );
}

/** "Renomear": the account's name, which people and agents tell it apart by (its tools keep their names). */
function RenameSheet({ item }: { item: ConnectedItem }) {
  const { t } = useTranslation();
  const c = useColors();
  const sheet = useSheet();
  const toast = useToast();
  const orgId = useOrgId();
  const rename = useRenameConnection(orgId);
  const [label, setLabel] = useState(item.label);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const wanted = label.trim();
    if (!wanted || wanted === item.label) return sheet.close();
    rename.mutate(
      { id: item.id, label: wanted },
      {
        onSuccess: (saved) => {
          successHaptic();
          sheet.close();
          toast({ title: t("connectors.renamed", { name: saved.label }) });
        },
        onError: (failed) => {
          errorHaptic();
          setError(knownErrorText(t, failed) ?? t("mobile.connectors.renameFailed"));
        },
      },
    );
  };
  return (
    <View style={styles.sheet}>
      <Text variant="title">{t("connectors.renameTitle", { name: itemName(t, item) })}</Text>
      <Text variant="small" tone="muted">
        {t("connectors.renameHelp")}
      </Text>
      <TextInput
        value={label}
        onChangeText={(v) => {
          setLabel(v);
          setError(null);
        }}
        maxLength={80}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
        accessibilityLabel={t("connectFlow.name")}
        style={[styles.field, { backgroundColor: c.raised, color: c.ink, borderColor: c.line }]}
      />
      {error ? <Problem text={error} /> : null}
      <Button variant="primary" wide label={t("common.save")} disabled={rename.isPending} onPress={save} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  sheet: { gap: 14 },
  field: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...fieldText("body"),
  },
  band: { alignItems: "center", gap: 8, paddingHorizontal: 24, paddingBottom: 22 },
  center: { textAlign: "center" },
  loading: { marginTop: 24 },
  // The pushed screens' 16-point margin (the connectors list and the settings screens use it too).
  body: { paddingHorizontal: 16, gap: 12 },
  section: { fontWeight: "600", paddingTop: 6 },
});
