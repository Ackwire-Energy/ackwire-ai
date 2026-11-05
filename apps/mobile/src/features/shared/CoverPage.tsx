import { useHeaderHeight } from "expo-router/react-navigation";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WorkspaceSky } from "@/sky/Sky";
import { Count, Icon, type IconName, Text, textLineOf, weights } from "@/ui";
import { CoverBarBackdrop, CoverParallax, useCoverScroll } from "@/ui/cover";
import { leadBox } from "@/ui/type-scale";
import { useColors } from "./hooks";
import { PushedHeader, Tile } from "./parts";

/**
 * A page pushed with the workspace's sky on top, in Conversas' language (Você, the workspace's settings): the
 * native bar clear over the sky, which lags behind the scroll and stretches on a pull; a face, a title and a
 * line under it, the actions; then loose sections (`PageSection`, `PageRow`) on the page's white. Once the page
 * scrolls under the bar, the bar becomes its own (`CoverBarBackdrop`).
 */
export function CoverPage({
  face,
  title,
  headline,
  actions,
  children,
}: {
  face: ReactNode;
  title: string;
  headline?: string | undefined;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { y, onScroll } = useCoverScroll();
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader plate solid={false} />
      <Animated.ScrollView
        style={styles.fill}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}
      >
        {/* The workspace's sky, as on Conversas, reaching up behind the clear bar and the status bar. */}
        <View style={[styles.band, { paddingTop: insets.top + 62 }]}>
          <CoverParallax y={y} style={StyleSheet.absoluteFill}>
            <WorkspaceSky fade={0.4} style={StyleSheet.absoluteFill} />
          </CoverParallax>
          <View style={styles.faceLine}>
            {face}
            <View style={styles.grow}>
              <Text variant="display2" numberOfLines={2}>
                {title}
              </Text>
              {headline ? (
                <Text variant="small" tone="muted" numberOfLines={1}>
                  {headline}
                </Text>
              ) : null}
            </View>
          </View>
          {actions ? <View style={styles.acts}>{actions}</View> : null}
        </View>
        {children}
      </Animated.ScrollView>
      <CoverBarBackdrop y={y} from={0} to={12} height={headerHeight} />
    </View>
  );
}

/** A section's head, as Conversas' ("Agentes 4"): the title and its count, faint. */
export function PageSection({ title, count }: { title: string; count?: number | undefined }) {
  const c = useColors();
  return (
    <View style={styles.section}>
      <Text variant="small" tone="ink" style={styles.sectionTitle} accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      {count !== undefined ? <Count value={count} size={15} weight={weights.medium} color={c.faint} /> : null}
    </View>
  );
}

/**
 * A loose row, as Conversas' (the hairline starts at the text): a tile, the label, a value, the chevron. With
 * `below` the tile stays at the top with the label, and the value and the chevron on the label's line.
 */
export function PageRow({
  icon,
  leading,
  label,
  value,
  below,
  onPress,
  divider = false,
  danger = false,
  chevron = true,
}: {
  icon?: IconName;
  leading?: ReactNode;
  label: string;
  value?: string | undefined;
  below?: ReactNode;
  onPress: () => void;
  divider?: boolean;
  danger?: boolean;
  chevron?: boolean;
}) {
  const c = useColors();
  const { fontScale } = useWindowDimensions();
  const lead = leading ?? (icon ? <Tile icon={icon} size={TILE} /> : null);
  // Beside a row that grows under its label, what is on the right stays on the label's line, not the row's middle.
  const line = below ? textLineOf("body", fontScale) : null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.rowLine, { backgroundColor: c.line2 }]} /> : null}
      {lead ? (
        // Beside a row that grows under its label (a plan's meter), the tile stays with the label, at the top.
        <View style={below ? styles.top : undefined}>{lead}</View>
      ) : null}
      <View style={styles.grow}>
        <Text variant="body" tone={danger ? "danger" : "ink"} numberOfLines={1}>
          {label}
        </Text>
        {below}
      </View>
      {value ? (
        <Text variant="body" tone="faint" numberOfLines={1} style={[styles.value, line ? styles.top : null]}>
          {value}
        </Text>
      ) : null}
      {chevron ? (
        <View style={line ? [styles.top, leadBox(line, 15)] : undefined}>
          <Icon name="right" size={15} color={c.faint} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** The rows' tile, and what a leading face of the same size takes. */
export const TILE = 36;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  // Not clipped: on a pull the sky grows up into the gap above the content.
  band: { paddingHorizontal: 20, paddingBottom: 18 },
  faceLine: { flexDirection: "row", alignItems: "center", gap: 14 },
  // Wraps: two buttons with long labels (some languages) would run past the screen's edge in one line.
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 16 },
  section: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 22,
    paddingHorizontal: 20,
    // 8 under the title, as the Chats list's section heads (the kit's SectionHeader).
    paddingBottom: 8,
  },
  sectionTitle: { fontWeight: "600", flexShrink: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  // From the text column: 20 + the 36 tile + 13.
  rowLine: { position: "absolute", top: 0, right: 0, left: 69, height: StyleSheet.hairlineWidth },
  value: { maxWidth: "45%" },
  top: { alignSelf: "flex-start" },
});
