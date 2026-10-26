import { type ConnectorDef, useCatalog, useConnections, useCustomServers } from "@agenteschat/client";
import { connectedItems } from "@agenteschat/client/lib/connected";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorDescription, connectorName } from "@agenteschat/client/lib/scopes";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Dither } from "@/sky/Dither";
import { Button, EmptyState, Filters, Icon, SearchField, SectionHeader, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { ConnectorIcon } from "./ConnectorIcon";
import { AddressSheet, ConnectSheet } from "./ConnectSheet";
import { brandOf, brandTones, CATEGORIES, connectionOf, searchConnectors, suggestionsOf } from "./logic";

/**
 * Conectores on the phone: what is connected as a row of icons
 * with a check (and "Endereço" to connect any server by its address), three suggestions with a strip in the
 * brand's tone, then every service as even tiles in two columns, filtered by category. A tile opens a sheet
 * over the gallery with the whole flow in three steps: what agents could do → connect → who uses it.
 */
export function ConnectorsScreen() {
  return (
    <SheetHostProvider>
      <Gallery />
    </SheetHostProvider>
  );
}

function Gallery() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  // Servers connected by address (a vendor's own, like Sentry's) come from their own list, as on the web.
  const servers = useCustomServers(orgId);
  const pull = usePullRefresh(async () => {
    await Promise.all([catalog.refetch(), connections.refetch(), servers.refetch()]);
  });
  // Connecting is for admins (the server checks it too).
  const admin = can(org?.role, "configure");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const list = catalog.data?.connectors ?? [];
  const items = useMemo(
    () => connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []),
    [connections.data, servers.data, catalog.data],
  );
  const name = (d: ConnectorDef) => connectorName(t, d);
  const connected = useMemo(() => list.filter((d) => connectionOf(d, items)), [list, items]);
  const suggestions = useMemo(() => suggestionsOf(list, items), [list, items]);
  const searching = q.trim().length > 0;
  const rest = useMemo(() => {
    const pool = searching ? list : list.filter((d) => !suggestions.includes(d));
    const inCat = cat === "all" ? pool : pool.filter((d) => d.category === cat);
    return searchConnectors(inCat, q, (d) => `${connectorName(t, d)} ${connectorDescription(t, d)}`);
  }, [list, suggestions, cat, q, searching, t]);
  const cats = CATEGORIES.filter((k) => list.some((d) => d.category === k));
  const open = (def: ConnectorDef) => sheet.open(<ConnectSheet def={def} />);

  return (
    <PushedLargeTitle
      title={t("mobile.connectors.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.connectors.search")}
          accessibilityLabel={t("mobile.connectors.search")}
          returnKeyType="search"
        />
      </View>
      {catalog.isLoading || connections.isLoading || servers.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.muted} />
        </View>
      ) : catalog.isError && !catalog.data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.connectors.loadFailed")}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            label={t("mobile.common.retry")}
            onPress={() => void catalog.refetch()}
          />
        </View>
      ) : (
        <>
          {searching ? null : connected.length > 0 ? (
            <>
              <SectionHeader title={t("mobile.connectors.connected")} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                {connected.map((d) => (
                  <Pressable
                    key={d.id}
                    onPress={() => open(d)}
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.connectors.connectedCheck", { name: name(d) })}
                    style={styles.mini}
                  >
                    <ConnectorIcon def={d} label={name(d)} size={48} check />
                    <Text variant="caption" tone="muted" numberOfLines={1}>
                      {name(d)}
                    </Text>
                  </Pressable>
                ))}
                {admin ? <AddressTile onPress={() => sheet.open(<AddressSheet />)} /> : null}
              </ScrollView>
            </>
          ) : (
            <EmptyHint admin={admin} onAddress={() => sheet.open(<AddressSheet />)} />
          )}
          {!searching && suggestions.length > 0 ? (
            <>
              <SectionHeader title={t("mobile.connectors.suggested", { org: org?.name ?? "" })} />
              <View style={styles.suggestions}>
                {suggestions.map((d) => (
                  <Suggestion key={d.id} def={d} name={name(d)} text={connectorDescription(t, d)} onPress={open} />
                ))}
              </View>
            </>
          ) : null}
          {cats.length > 1 ? (
            // Under the search it sits close; after the sections above it starts a new one (their spacing).
            <View style={searching ? undefined : styles.filters}>
              <Filters
                items={[
                  { key: "all", label: t("mobile.connectors.all") },
                  ...cats.map((k) => ({ key: k, label: t(`connectors.category.${k}`) })),
                ]}
                value={cat}
                onChange={setCat}
              />
            </View>
          ) : null}
          {rest.length === 0 ? (
            <EmptyState title={t("mobile.connectors.noResults")} />
          ) : (
            <View style={styles.grid}>
              {rest.map((d) => (
                <Tile
                  key={d.id}
                  def={d}
                  name={name(d)}
                  text={d.available ? connectorDescription(t, d) : t("mobile.connectors.soon")}
                  connected={Boolean(connectionOf(d, items))}
                  onPress={d.available ? open : undefined}
                />
              ))}
            </View>
          )}
        </>
      )}
    </PushedLargeTitle>
  );
}

/** Nothing connected yet: who would use it, in a line (agents only on a subject about them). */
function EmptyHint({ admin, onAddress }: { admin: boolean; onAddress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const faces = dir.agents.slice(0, 3);
  return (
    <View style={[styles.empty, { borderColor: c.line }]}>
      <View style={styles.faces}>
        {faces.map((a, i) => (
          <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
            <AgentFace agentId={a.id} size={30} live={false} />
          </View>
        ))}
      </View>
      <View style={styles.grow}>
        <Text variant="body" style={styles.bold}>
          {t("mobile.connectors.empty")}
        </Text>
        <Text variant="small" tone="muted">
          {t("mobile.connectors.emptySub")}
        </Text>
        {admin ? (
          // Under the text, spelled out: beside it, it squeezed the text into a narrow column; a globe alone
          // didn't say it connects a service by its MCP address.
          <Pressable
            onPress={onAddress}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.connectors.addressTitle")}
            hitSlop={6}
            style={styles.byAddress}
          >
            <Icon name="globe" size={15} color={c.muted} />
            <Text variant="small" style={styles.bold}>
              {t("mobile.connectors.byAddress")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function AddressTile({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.connectors.addressTitle")}
      style={styles.mini}
    >
      <View style={[styles.addTile, { borderColor: c.line2 }]}>
        <Icon name="plus" size={20} color={c.muted} />
      </View>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {t("mobile.connectors.address")}
      </Text>
    </Pressable>
  );
}

/** A suggestion: a strip of pixels in the brand's tone with its mark, the name and what it is. */
function Suggestion({
  def,
  name,
  text,
  onPress,
}: {
  def: ConnectorDef;
  name: string;
  text: string;
  onPress: (def: ConnectorDef) => void;
}) {
  const c = useColors();
  const brand = brandOf(def.brandColor) ?? c.ink2;
  return (
    <Pressable
      onPress={() => onPress(def)}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${text}`}
      style={({ pressed }) => [styles.card, { borderColor: c.line }, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={styles.band}>
        <Dither kind="sky" tones={brandTones(c.bg, brand)} pixel={3} animated={false} style={StyleSheet.absoluteFill} />
        <ConnectorIcon def={def} label={name} size={44} />
      </View>
      <View style={styles.cardText}>
        <Text variant="body" numberOfLines={1} style={styles.bold}>
          {name}
        </Text>
        <Text variant="small" tone="muted" numberOfLines={2}>
          {text}
        </Text>
      </View>
    </Pressable>
  );
}

function Tile({
  def,
  name,
  text,
  connected,
  onPress,
}: {
  def: ConnectorDef;
  name: string;
  text: string;
  connected: boolean;
  onPress?: ((def: ConnectorDef) => void) | undefined;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress ? () => onPress(def) : undefined}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${text}`}
      style={({ pressed }) => [
        styles.tile,
        { borderColor: c.line },
        pressed && { backgroundColor: c.sunken },
        !onPress && { opacity: 0.55 },
      ]}
    >
      <ConnectorIcon def={def} label={name} size={40} check={connected} />
      <Text variant="body" numberOfLines={1} style={styles.bold}>
        {name}
      </Text>
      <Text variant="small" tone="muted" numberOfLines={2}>
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 6 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  row: { gap: 14, paddingHorizontal: 16, paddingBottom: 6 },
  mini: { width: 64, alignItems: "center", gap: 6 },
  addTile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 14,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -8 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  byAddress: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", marginTop: 8 },
  suggestions: { gap: 10, paddingHorizontal: 16 },
  filters: { paddingTop: 20 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  band: { width: 88, alignSelf: "stretch", minHeight: 72, alignItems: "center", justifyContent: "center" },
  cardText: { flex: 1, minWidth: 0, paddingVertical: 12, paddingRight: 14 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: 16, paddingTop: 10 },
  tile: {
    width: "48%",
    flexGrow: 1,
    gap: 6,
    padding: 14,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
