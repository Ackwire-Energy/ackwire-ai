import { useCatalog, useConnections, useCustomServers } from "@agenteschat/client";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Dither } from "@/sky/Dither";
import { Icon, Text } from "@/ui";
import { CoverBarBackdrop, CoverParallax, useCoverScroll } from "@/ui/cover";
import { useColors, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, Tile } from "../shared/parts";
import { ConnectorIcon } from "./ConnectorIcon";
import { AgentLevels, DisconnectButton, SafeNote } from "./ConnectSheet";
import { brandOf, brandTones } from "./logic";
import { openTools } from "./ToolsScreen";

/** Opens a connection's own screen (from its tile or its icon in Conectores). */
export const openConnection = (id: string) => router.push(`/connectors/${id}`);

/**
 * A connection, a screen pushed over Conectores: its brand's pixel sky behind the native clear bar (lagging behind
 * the scroll, as an agent's page), its icon with the check, its name and account; who uses it and how far (one
 * choice per agent), what always asks, its tools (Ferramentas, a screen of their own; "Revisar" while some wait)
 * and disconnecting it. Connecting a new service stays in its sheet.
 */
export function ConnectionScreen({ id }: { id: string }) {
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
  const { y, onScroll } = useCoverScroll();
  const item = connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
    (i) => i.id === id,
  );
  const loading = !item && (catalog.isPending || connections.isPending || servers.isPending);
  const name = item ? itemName(t, item) : "";
  const brand = (item?.def ? brandOf(item.def.brandColor) : null) ?? c.ink2;
  // The account when it says something the name doesn't (a server's host often is its name), else the category.
  const sub =
    item?.account && item.account !== name
      ? item.account
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
            <AgentLevels connectionId={id} />
            <SafeNote />
            {admin ? (
              <Pressable
                onPress={() => openTools(id)}
                accessibilityRole="button"
                accessibilityLabel={`${t("connectors.tools")}, ${
                  waiting > 0
                    ? t("toolReview.decideTitle", { count: waiting })
                    : t("toolReview.subjectCount", { count: item.tools })
                }`}
                style={({ pressed }) => [
                  styles.tools,
                  { borderColor: c.line },
                  pressed && { backgroundColor: c.sunken },
                ]}
              >
                <Tile icon="list" size={36} />
                <View style={styles.grow}>
                  <Text variant="body" style={styles.bold}>
                    {t("connectors.tools")}
                  </Text>
                  <Text variant="small" tone="muted" numberOfLines={1} style={waiting > 0 && { color: c.warn }}>
                    {waiting > 0
                      ? t("toolReview.decideTitle", { count: waiting })
                      : t("toolReview.subjectCount", { count: item.tools })}
                  </Text>
                </View>
                {waiting > 0 ? (
                  <Text variant="small" style={[styles.bold, { color: c.warn }]}>
                    {t("connectors.review")}
                  </Text>
                ) : null}
                <Icon name="right" size={15} color={c.faint} />
              </Pressable>
            ) : null}
            {admin ? <DisconnectButton item={item} name={name} onDone={goBack} /> : null}
          </View>
        ) : null}
      </Animated.ScrollView>
      {/* What the clear bar becomes once the page scrolls under it, as on an agent's page and Você. */}
      <CoverBarBackdrop y={y} from={0} to={12} height={headerHeight} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  band: { alignItems: "center", gap: 8, paddingHorizontal: 24, paddingBottom: 22 },
  center: { textAlign: "center" },
  loading: { marginTop: 24 },
  body: { paddingHorizontal: 20, gap: 12 },
  section: { fontWeight: "600", paddingTop: 6 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  tools: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
