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
import { useHeaderHeight } from "expo-router/react-navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, fieldText, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Locked, Text, useToast } from "@/ui";
import { CoverBarBackdrop, useCoverScroll } from "@/ui/cover";
import { router } from "@/ui/navigation";
import { useColors, useOrgId } from "../shared/hooks";
import { errorHaptic, goBack, PushedHeader, successHaptic, Tile } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { AgentLevelList, DisconnectRow, WaitTile } from "./Access";
import { ConnectorIcon } from "./ConnectorIcon";
import { AddressSheet, ConnectSheet } from "./ConnectSheet";
import { accountActions } from "./logic";
import { Problem } from "./Problem";
import { openTools } from "./ToolsScreen";

/** Opens a connection's own screen (from its tile or its icon in Conectores). */
export const openConnection = (id: string) => router.push(`/connectors/${id}`);

/**
 * A connection, a screen pushed over Conectores, laid out as the phone's settings (groups on the grouped gray): its
 * icon with the check, its name and account; who uses it and how far (one row per agent, the level as its value),
 * what always asks as that group's footer; its tools (what waits on you first, in amber, then all of them, a screen
 * of their own); the account itself (Renomear, Reconectar, another account of an MCP server, each in a sheet); and
 * Desconectar, alone in red, after a confirmation. Connecting a new service stays in its sheet.
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
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader plate solid={false} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View style={[styles.head, { paddingTop: insets.top + 56 }]}>
          <ConnectorIcon
            def={item?.def ?? null}
            image={item?.image}
            label={name || "·"}
            size={60}
            check={Boolean(item)}
          />
          <Text variant="title2" numberOfLines={2} style={styles.center}>
            {name}
          </Text>
          {sub ? (
            <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.center}>
              {sub}
            </Text>
          ) : null}
        </View>

        {loading ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : item ? (
          <View style={styles.body}>
            {item.needsReconnect ? (
              <Problem text={t("mobile.connectors.needsReconnect", { name })} />
            ) : item.reconnectAdds.length > 0 ? (
              <Text variant="footnote" tone="muted" style={styles.lead}>
                {reconnectAddsText(t, item)}
              </Text>
            ) : null}
            <AgentLevelList connectionId={id} />
            {admin ? (
              <>
                <GroupedHeader>{t("connectors.tools")}</GroupedHeader>
                <GroupedList>
                  {waiting > 0 ? (
                    <GroupedRow
                      key="waiting"
                      leading={<WaitTile />}
                      label={t("toolReview.decideTitle", { count: waiting })}
                      chevron
                      onPress={() => openTools(id)}
                    />
                  ) : null}
                  <GroupedRow
                    key="all"
                    leading={<Tile icon="list" size={30} />}
                    label={t("connectors.tools")}
                    value={String(item.tools)}
                    chevron
                    onPress={() => openTools(id)}
                  />
                </GroupedList>
                <GroupedHeader>{t("mobile.connectors.accountTitle")}</GroupedHeader>
                <GroupedList>
                  {accountActions(item).map((action) =>
                    action === "rename" ? (
                      <GroupedRow
                        key={action}
                        label={t("connectors.rename")}
                        value={item.label}
                        chevron
                        onPress={() => sheet.open(<RenameSheet item={item} />)}
                      />
                    ) : (
                      <GroupedRow
                        key={action}
                        label={t(action === "add" ? "connectors.detail.addAccount" : "connectors.detail.reconnect")}
                        sub={t(
                          item.custom && accountUnchecked([item.server])
                            ? action === "add"
                              ? "connectFlow.newAccountUnchecked"
                              : "connectFlow.replaceUnchecked"
                            : action === "add"
                              ? "connectors.detail.accountsText"
                              : "connectors.detail.replaceText",
                        )}
                        subLines={2}
                        chevron
                        onPress={() =>
                          sheet.open(
                            item.def ? (
                              <ConnectSheet def={item.def} item={item} mode={action} />
                            ) : (
                              <AddressSheet item={item} mode={action} />
                            ),
                          )
                        }
                      />
                    ),
                  )}
                </GroupedList>
                <View style={styles.gap} />
                <DisconnectRow item={item} name={name} onDone={goBack} />
                {item.viaComposio ? (
                  <GroupedFooter>
                    {t("connectors.composio.disconnectNote", {
                      name: item.def ? connectorBrand(item.def) : name,
                    })}
                  </GroupedFooter>
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
      <Locked when={rename.isPending}>
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
      </Locked>
      {error ? <Problem text={error} /> : null}
      <Button variant="primary" wide label={t("common.save")} loading={rename.isPending} onPress={save} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  sheet: { gap: 14 },
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...fieldText("body"),
  },
  head: { alignItems: "center", gap: 6, paddingHorizontal: 24, paddingBottom: 6 },
  center: { textAlign: "center" },
  loading: { marginTop: 24 },
  // The pushed screens' 16-point margin (the connectors list and the settings screens use it too).
  body: { paddingHorizontal: 16 },
  lead: { paddingHorizontal: 16, paddingTop: 12 },
  gap: { height: 24 },
});
