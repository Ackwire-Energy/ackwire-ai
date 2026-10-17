import { router, useIsFocused } from "expo-router";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Share, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, fonts, haptics, Icon, IconButton, type IconName, LivePause, Text, useTheme } from "@/ui";
import { useColors } from "./hooks";

/**
 * Small pieces the screens share that the design system doesn't have as
 * primitives: the icon tile, the action list of sheets, the bar of a pushed
 * screen, haptics and the share sheet.
 */

/** The rounded square with an icon (channels, threads, missions, sheet actions). */
export function Tile({ icon, size = 36, children }: { icon?: IconName; size?: number; children?: ReactNode }) {
  const c = useColors();
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: Math.round(size / 3), backgroundColor: c.sunken },
      ]}
    >
      {children ?? (icon ? <Icon name={icon} size={Math.round(size / 2)} color={c.muted} /> : null)}
    </View>
  );
}

export interface ActionItem {
  key: string;
  icon?: IconName;
  leading?: ReactNode;
  label: string;
  hint?: string;
  /** A slash command shown on the right (`/mission`), in mono: it is code. */
  code?: string;
  trailing?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}

/** The list of actions in a sheet: icon, label, a hint under it. */
export function ActionList({ items }: { items: ActionItem[] }) {
  const c = useColors();
  return (
    <Card>
      {items.map((it, i) => (
        <Pressable
          key={it.key}
          onPress={it.onPress}
          disabled={it.disabled || !it.onPress}
          accessibilityRole="button"
          accessibilityLabel={it.hint ? `${it.label}. ${it.hint}` : it.label}
          style={({ pressed }) => [
            styles.action,
            i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
            pressed && { backgroundColor: c.sunken },
            it.disabled && { opacity: 0.5 },
          ]}
        >
          {it.leading ?? (it.icon ? <Icon name={it.icon} size={20} color={it.danger ? c.danger : c.muted} /> : null)}
          <View style={styles.actionText}>
            <Text variant="body" tone={it.danger ? "danger" : "ink"}>
              {it.label}
            </Text>
            {it.hint ? (
              <Text variant="small" tone="faint">
                {it.hint}
              </Text>
            ) : null}
          </View>
          {it.code ? <Text style={[styles.mono, { color: c.faint }]}>{it.code}</Text> : null}
          {it.trailing}
        </Pressable>
      ))}
    </Card>
  );
}

/** The bar of a pushed screen: back on the left, a title in the middle, an action on the right. */
export function PushedHeader({
  title,
  subtitle,
  right,
  plate = false,
  solid = true,
}: {
  title?: ReactNode;
  subtitle?: string;
  right?: ReactNode;
  /** Over a sky cover: the buttons sit on glass plates. */
  plate?: boolean;
  solid?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { t } = useTranslation();
  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top + 4 },
        solid && {
          backgroundColor: c.glass ?? c.bg,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: c.line,
        },
      ]}
    >
      <IconButton icon="back" label={t("mobile.common.back")} onPress={goBack} plate={plate} />
      <View style={styles.headerTitle}>
        {typeof title === "string" ? (
          <Text variant="body" numberOfLines={1} style={styles.titleText}>
            {title}
          </Text>
        ) : (
          title
        )}
        {subtitle ? (
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={styles.headerRight}>{right}</View>
    </View>
  );
}

/** Back, or home when the screen was opened by a link. */
export function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

/** A light tap under the thumb (long press, reactions, picks). */
export const tapHaptic = () => haptics.light();

/** Done: approved, sent. */
export const successHaptic = () => haptics.success();

/** The system share sheet with a text (it has "Copy"). */
export function shareText(text: string) {
  void Share.share({ message: text }).catch(() => {});
}

/** Code only (branches, commands). */
export const MONO = fonts.mono;

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center" },
  action: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  actionText: { flex: 1, minWidth: 0 },
  mono: { fontFamily: MONO, fontSize: 13 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingBottom: 6, gap: 4, zIndex: 10 },
  headerTitle: { flex: 1, alignItems: "center", minWidth: 0 },
  titleText: { fontFamily: fonts.semibold },
  headerRight: { minWidth: 40, alignItems: "flex-end" },
});

/** A raised, neutral surface (the cards inside messages): raised background, the e1 shadow and lit top edge. */
export function useSurface() {
  const { colors, shadows } = useTheme();
  return useMemo(
    () => ({ backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }),
    [colors.raised, shadows],
  );
}

/** Agents inside stop moving while the screen is not showing (another screen is on top). */
export function FocusLive({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  return <LivePause paused={!focused}>{children}</LivePause>;
}

/** A route that is only a sheet: closing lets the sheet slide away, then leaves the route. */
export function useClosingSheet() {
  const [open, setOpen] = useState(true);
  const closing = useRef(false);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setOpen(false);
    setTimeout(goBack, 340);
  }, []);
  return { open, close };
}
