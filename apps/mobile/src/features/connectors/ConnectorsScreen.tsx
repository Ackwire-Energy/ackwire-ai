import {
  type ConnectorDef,
  useCatalog,
  useComposioUsage,
  useConnections,
  useCustomServers,
  useMailAccounts,
} from "@agenteschat/client";
import { composioOffText, composioUsageText, nearComposioLimit } from "@agenteschat/client/lib/composio";
import { type ConnectedItem, connectedItems, isMcpItem, itemName } from "@agenteschat/client/lib/connected";
import { choiceOf, MAIL_BRANDS } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorDescription, connectorName } from "@agenteschat/client/lib/scopes";
import { useLocalSearchParams } from "expo-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { Dither } from "@/sky/Dither";
import {
  Button,
  EmptyState,
  Filters,
  Icon,
  LineIcon,
  PressScale,
  SearchField,
  SectionHeader,
  Text,
  useReducedMotion,
} from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useSurface } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { openConnection } from "./ConnectionScreen";
import { ConnectorIcon } from "./ConnectorIcon";
import { AddressSheet, ConnectSheet, ServerSheet } from "./ConnectSheet";
import {
  brandOf,
  brandTones,
  CATEGORIES,
  connectionOf,
  galleryTiles,
  isHttpsUrl,
  SUGGESTED,
  searchConnectors,
  shownMailboxes,
  suggestionsOf,
} from "./logic";
import { MailboxSheet } from "./MailboxSheet";

/**
 * Conectores on the phone: what is connected as a row of icons
 * with a check (and "Endereço" to connect any server by its address), three suggestions with a strip in the
 * brand's tone, then every service as even tiles in two columns, filtered by
 * category. A service not connected opens a sheet over the gallery with the flow in four steps: what agents could
 * do → connect → its tools → who uses it; a connection opens its own screen (who uses it, its tools,
 * disconnecting). A mailbox, of any kind, opens a sheet of who uses it.
 */
export function ConnectorsScreen() {
  return (
    <SheetHostProvider>
      <Gallery />
    </SheetHostProvider>
  );
}

function Gallery() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const catalog = useCatalog();
  const composio = useComposioUsage(orgId);
  const connections = useConnections(orgId);
  // Servers connected by address (a vendor's own, like Sentry's) come from their own list, as on the web.
  const servers = useCustomServers(orgId);
  // Mailboxes (ADR 0038): rows of what is connected; they connect on the web.
  const mailAccounts = useMailAccounts(orgId);
  const mailboxes = shownMailboxes(mailAccounts.data ?? []);
  const pull = usePullRefresh(async () => {
    await Promise.all([catalog.refetch(), connections.refetch(), servers.refetch(), mailAccounts.refetch()]);
  });
  // Connecting is for who manages connectors (the server checks it too).
  const admin = can(org, "manage_connectors");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const list = catalog.data?.connectors ?? [];
  const items = useMemo(
    () => connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []),
    [connections.data, servers.data, catalog.data],
  );
  const apps = items.filter((i) => !isMcpItem(i));
  const mcps = items.filter(isMcpItem);
  const connectedCount = items.length + mailboxes.length;
  const name = (d: ConnectorDef) => connectorName(t, d);
  const suggestions = useMemo(() => suggestionsOf(list, items), [list, items]);
  const searching = q.trim().length > 0;
  const rest = useMemo(() => {
    const pool = searching ? list : list.filter((d) => !suggestions.includes(d));
    const inCat = cat === "all" ? pool : pool.filter((d) => d.category === cat);
    return searchConnectors(inCat, q, (d) => `${connectorName(t, d)} ${connectorDescription(t, d)}`);
  }, [list, suggestions, cat, q, searching, t]);
  const cats = CATEGORIES.filter((k) => list.some((d) => d.category === k));
  // What is already connected is in the row above; the grid shows it only to a search.
  const tiles = galleryTiles(rest, items).filter((x) => searching || !x.connected);
  // Without Composio here, the services that connect only through it are left out: admins read why.
  const composioOff = admin ? composioOffText(t, list, SUGGESTED) : null;
  const open = (def: ConnectorDef) => {
    const existing = connectionOf(def, items);
    if (existing) openConnection(existing.id);
    else sheet.open(<ConnectSheet def={def} />);
  };
  // Connecting by an address: the one typed in the search when it is one.
  const openAddress = () => sheet.open(<AddressSheet {...(isHttpsUrl(q.trim()) ? { url: q.trim() } : {})} />);
  // A connection opens its own screen (a server connected by an address we don't know included).
  const openItem = (item: ConnectedItem) => openConnection(item.id);
  // From an agent's card in the chat (`?connect=<catalog id>` or `?mcp=<address>`, `?mcp=` alone: any address): the
  // same sheet the gallery opens, once the catalog is in.
  const { connected, connect, mcp } = useLocalSearchParams<{ connected?: string; connect?: string; mcp?: string }>();
  const offered = useRef(false);
  useEffect(() => {
    if (offered.current || (connect === undefined && mcp === undefined) || !catalog.data || !admin) return;
    offered.current = true;
    const def = connect ? catalog.data.connectors.find((d) => d.id === connect) : undefined;
    if (def) open(def);
    else sheet.open(<AddressSheet url={mcp || undefined} />);
  });
  // Back from a sign-in that finished on the link route (`?connected=<id>`): its tools, as the web opens
  // "O que faz" for the connection that just came in (admins; anyone else had the toast).
  const returned = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || returned.current === connected || !connections.data || !servers.data || !catalog.data) return;
    returned.current = connected;
    const item = items.find((i) => i.id === connected);
    if (!item || !admin) return;
    sheet.open(
      item.def ? (
        <ConnectSheet def={item.def} item={item} start="review" fresh />
      ) : (
        <ServerSheet item={item} start="review" fresh />
      ),
    );
  }, [connected, connections.data, servers.data, catalog.data, items, admin, sheet]);

  return (
    <PushedLargeTitle
      title={t("mobile.connectors.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {composio.data && nearComposioLimit(composio.data) ? (
        <Text variant="small" tone="muted" style={styles.usage}>
          {composioUsageText(t, i18n.language, composio.data)}
        </Text>
      ) : null}
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
          {/* A pasted address connects a server by it, from the search itself. */}
          {searching && admin && isHttpsUrl(q.trim()) ? <AddressRow url={q.trim()} onPress={openAddress} /> : null}
          {searching ? null : (
            <>
              {admin || connectedCount > 0 ? (
                <>
                  <SectionHeader
                    title={t("mobile.connectors.connected")}
                    {...(connectedCount > 0 ? { count: connectedCount } : {})}
                  />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                    {/* A connection made or removed while the row is in sight fades, and the others slide over. */}
                    <LayoutAnimationConfig skipEntering>
                      {/* Adding one opens the row: always in sight, never at the end of a sideways scroll. */}
                      {admin ? <AddressTile onPress={() => sheet.open(<AddressSheet />)} /> : null}
                      {/* Mailboxes first, as on the web, by their name ("Suporte"). */}
                      {mailboxes.map((a) => (
                        <MiniTile
                          key={a.id}
                          onPress={() => sheet.open(<MailboxSheet accountId={a.id} />)}
                          label={t("mobile.connectors.connectedCheck", { name: a.label })}
                        >
                          <ConnectorIcon def={MAIL_BRANDS[choiceOf(a)] ?? null} label={a.label} size={48} check />
                          <Text variant="caption" tone="muted" numberOfLines={1}>
                            {a.label}
                          </Text>
                        </MiniTile>
                      ))}
                      {/* Services, then servers connected by address (oldest first, as on the web). */}
                      {[...apps, ...mcps].map((item) => (
                        <ConnectedTile
                          key={item.id}
                          item={item}
                          waiting={admin && item.pending > 0}
                          onPress={() => openItem(item)}
                        />
                      ))}
                    </LayoutAnimationConfig>
                  </ScrollView>
                </>
              ) : null}
              {connectedCount === 0 ? <EmptyHint /> : null}
            </>
          )}
          {!searching && suggestions.length > 0 ? (
            <>
              <SectionHeader title={t("mobile.connectors.suggested", { org: org?.name ?? "" })} />
              <View style={styles.suggestions}>
                {suggestions.map((d) => (
                  <Suggestion
                    key={d.id}
                    mark={d}
                    name={name(d)}
                    text={connectorDescription(t, d)}
                    onPress={() => open(d)}
                  />
                ))}
              </View>
            </>
          ) : null}
          {searching ? null : <SectionHeader title={t("connectors.more")} count={tiles.length} />}
          {cats.length > 1 ? (
            <View style={styles.filters}>
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
          {tiles.length === 0 ? (
            <EmptyState
              icon="search"
              title={t("mobile.connectors.noResults")}
              action={
                admin ? (
                  <Button variant="secondary" size="sm" label={t("connectors.otherConnect")} onPress={openAddress} />
                ) : null
              }
            />
          ) : (
            <View style={styles.grid}>
              {tiles.map(({ def: d, connected: isConnected, opens, locked }) => (
                <Tile
                  key={d.id}
                  def={d}
                  name={name(d)}
                  text={opens ? connectorDescription(t, d) : t("mobile.connectors.soon")}
                  connected={isConnected}
                  locked={locked}
                  onPress={opens ? open : undefined}
                />
              ))}
              {/* An odd last tile keeps its column's width instead of growing across the row. */}
              {tiles.length % 2 === 1 ? <View style={styles.tileSpacer} /> : null}
            </View>
          )}
          {composioOff ? (
            <Text variant="small" tone="muted" style={styles.note}>
              {composioOff}
            </Text>
          ) : null}
        </>
      )}
    </PushedLargeTitle>
  );
}

/** Nothing connected yet: who would use it, in a line (the MCPs section under it adds one by its address). */
function EmptyHint() {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const faces = dir.agents.slice(0, 3);
  return (
    <View style={[styles.empty, { borderColor: c.line }]}>
      <View style={styles.faces}>
        {faces.map((a, i) => (
          <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
            <AgentFace agentId={a.id} size={34} live={false} />
          </View>
        ))}
      </View>
      <View style={styles.hintText}>
        <Text variant="body" style={styles.bold}>
          {t("mobile.connectors.empty")}
        </Text>
        <Text variant="small" tone="muted">
          {t("mobile.connectors.emptySub")}
        </Text>
      </View>
    </View>
  );
}

/**
 * A connection in the row: its mark with the check, its name; when its tools wait on you (a server's new or unclear
 * tools), the amber wait mark and its name in amber instead (its screen lists them first).
 */
function ConnectedTile({ item, waiting, onPress }: { item: ConnectedItem; waiting: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const name = itemName(t, item);
  return (
    <MiniTile
      onPress={onPress}
      label={
        waiting
          ? `${name}, ${t("toolReview.decideTitle", { count: item.pending })}`
          : t("mobile.connectors.connectedCheck", { name })
      }
    >
      <View>
        <ConnectorIcon def={item.def} image={item.image} label={name} size={48} check={!waiting} />
        {waiting ? (
          <View style={[styles.waitBadge, { backgroundColor: c.amber, borderColor: c.bg }]}>
            <Icon name="wait" size={12} color={c.bg} />
          </View>
        ) : null}
      </View>
      <Text
        variant="caption"
        tone="muted"
        numberOfLines={1}
        style={waiting ? [styles.bold, { color: c.amber }] : undefined}
      >
        {name}
      </Text>
    </MiniTile>
  );
}

const TILE_IN = FadeIn.duration(160);
const TILE_OUT = FadeOut.duration(120);
const TILE_SLIDE = LinearTransition.duration(220);

/**
 * A tile of the connected row: it gives under the finger (opening it is plain navigation, so no haptic), and it fades
 * in or out as a connection is made or removed while the row is in sight (none of it with reduced motion).
 */
function MiniTile({ onPress, label, children }: { onPress: () => void; label: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <Animated.View
      entering={reduced ? undefined : TILE_IN}
      exiting={reduced ? undefined : TILE_OUT}
      layout={reduced ? undefined : TILE_SLIDE}
    >
      <PressScale
        haptic={false}
        fill={false}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.mini}
        contentStyle={styles.miniIn}
      >
        {children}
      </PressScale>
    </Animated.View>
  );
}

/** Searching with an address: connecting a server by it, one tap. */
function AddressRow({ url, onPress }: { url: string; onPress: () => void }) {
  const { t } = useTranslation();
  const surface = useSurface();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, styles.address, surface, pressed && styles.pressed]}
    >
      <View style={[styles.cardText, styles.addressText]}>
        <Text variant="body" numberOfLines={1} style={styles.bold}>
          {t("connectors.otherConnect")}
        </Text>
        <Text variant="small" tone="muted" numberOfLines={1}>
          {url}
        </Text>
      </View>
    </Pressable>
  );
}

function AddressTile({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <MiniTile onPress={onPress} label={t("mobile.connectors.addMcp")}>
      <View style={[styles.addTile, { borderColor: c.line2 }]}>
        <Icon name="plus" size={20} color={c.muted} />
      </View>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {t("mobile.connectors.addMcp")}
      </Text>
    </MiniTile>
  );
}

/** A suggestion: a strip of pixels in the brand's tone with its mark, the name and what it is. */
function Suggestion({
  mark,
  name,
  text,
  onPress,
}: {
  mark: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
  name: string;
  text: string;
  onPress: () => void;
}) {
  const c = useColors();
  const surface = useSurface();
  const brand = brandOf(mark?.brandColor ?? null) ?? c.ink2;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${text}`}
      style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}
    >
      <View style={styles.band}>
        <Dither
          kind="sky"
          tones={brandTones(c.raised, brand)}
          pixel={3}
          animated={false}
          style={StyleSheet.absoluteFill}
        />
        <ConnectorIcon def={mark} label={name} size={44} />
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
  locked,
  onPress,
}: {
  def: ConnectorDef;
  name: string;
  text: string;
  connected: boolean;
  locked: boolean;
  onPress?: ((def: ConnectorDef) => void) | undefined;
}) {
  const c = useColors();
  const surface = useSurface();
  return (
    <Pressable
      onPress={onPress ? () => onPress(def) : undefined}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${text}`}
      style={({ pressed }) => [
        styles.tile,
        // Coming soon sits sunk in the page, not raised like what opens.
        onPress ? surface : [styles.soon, { backgroundColor: c.sunken }],
        pressed && styles.pressed,
      ]}
    >
      <ConnectorIcon def={def} label={name} size={40} check={connected} />
      <Text variant="body" numberOfLines={1} style={styles.bold}>
        {name}
      </Text>
      <View style={styles.tileText}>
        {locked ? <LineIcon variant="small" name="lock" size={13} color={c.muted} /> : null}
        <Text variant="small" tone="muted" numberOfLines={2} style={styles.grow}>
          {text}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 6 },
  note: { paddingHorizontal: 16, paddingTop: 16 },
  usage: { paddingHorizontal: 16, paddingBottom: 8 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  row: { gap: 14, paddingHorizontal: 16, paddingBottom: 6 },
  mini: { width: 64 },
  miniIn: { alignItems: "center", gap: 6 },
  addTile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  // A column: the team's faces on top, then the line, its text and "Pelo endereço" (in a row the faces
  // took a third of the width and the text wrapped into a narrow block).
  empty: {
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 16,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -8 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  hintText: { gap: 2 },
  suggestions: { gap: 10, paddingHorizontal: 16 },
  filters: { paddingBottom: 2 },
  // The app's card with its cut corner (no hairline box), as every card standing on the page.
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    overflow: "hidden",
  },
  pressed: { opacity: 0.85 },
  soon: { opacity: 0.55 },
  band: { width: 88, alignSelf: "stretch", minHeight: 72, alignItems: "center", justifyContent: "center" },
  cardText: { flex: 1, minWidth: 0, paddingVertical: 12, paddingRight: 14 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: 16, paddingTop: 10 },
  // The lock stays on the first line of a two-line description, not between its lines.
  tileText: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  tile: {
    width: "48%",
    flexGrow: 1,
    gap: 6,
    padding: 14,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
  },
  waitBadge: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  address: { marginHorizontal: 16, marginTop: 8 },
  addressText: { paddingLeft: 16 },
  tileSpacer: { width: "48%", flexGrow: 1 },
});
