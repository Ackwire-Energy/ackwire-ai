import * as Clipboard from "expo-clipboard";
import { type NativeStackNavigationOptions, router, Stack, useIsFocused } from "expo-router";
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { needsHeaderBlur } from "@/lib/nav";
import {
  Button,
  Card,
  coverBarOptions,
  fonts,
  HeaderCapsule,
  HeaderSlot,
  type HeaderSlotStore,
  haptics,
  Icon,
  type IconName,
  LivePause,
  Text,
  ToggleSwitch,
  useHeaderSlot,
  useScrollUnderPushedOptions,
  useTheme,
} from "@/ui";
import { useColors } from "./hooks";

/**
 * Small pieces the screens share that the design system doesn't have as
 * primitives: the icon tile, the action list of sheets, the bar of a pushed
 * screen, haptics and the clipboard.
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
  /** A switch on the right ("Seguir"): the row reads as one, checked or not. */
  checked?: boolean;
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
          accessibilityRole={it.checked === undefined ? "button" : "switch"}
          {...(it.checked === undefined ? {} : { accessibilityState: { checked: it.checked } })}
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
          {it.checked === undefined ? null : <ToggleSwitch value={it.checked} />}
        </Pressable>
      ))}
    </Card>
  );
}

const IOS = Platform.OS === "ios";
/** iOS 26's Liquid Glass bar (a saving word there is a prominent button). */
const liquidGlass = IOS && !needsHeaderBlur(Platform.OS, Platform.Version);

/**
 * The bar of a pushed screen, as the native header (react-native-screens): the system back chevron with
 * the edge swipe, a title (with a subtitle under it when given), an action on the right. Renders nothing
 * itself; it sets the screen's header options, so screens keep calling it where the bar used to be.
 * The bar is opaque by default (`solid`, content lays out below it); `solid={false}` makes content scroll
 * under it (glass on iOS 26, blur before; the screen's scroll view needs
 * `contentInsetAdjustmentBehavior="automatic"`); `plate` puts a clear bar over a full-bleed cover. On Android
 * the right actions float in a `HeaderCapsule` and the back button is a round plate (`usePushedOptions`);
 * its opaque bar takes the screen's color (`grouped`), so no band shows above a grouped gray screen.
 * `action` is a word on the right that saves (Conta's "OK"): the system's bar button on iOS (prominent on
 * iOS 26), our small primary button on Android.
 */
export function PushedHeader({
  title,
  subtitle,
  right,
  action,
  plate = false,
  solid = true,
  grouped = false,
}: {
  title?: ReactNode;
  subtitle?: string;
  right?: ReactNode;
  action?: HeaderWordAction;
  /** Over a sky cover: a clear bar, the back button over the art. */
  plate?: boolean;
  solid?: boolean;
  /** The screen sits on the grouped gray (the bar matches it where it is opaque: Android). */
  grouped?: boolean;
}) {
  const { colors } = useTheme();
  const scrollUnder = useScrollUnderPushedOptions();
  const barTone = grouped && Platform.OS === "android" ? colors.grouped : null;
  const text = typeof title === "string" ? title : "";
  const titleNode = useHeaderSlot(typeof title === "string" ? null : title);
  const rightNode = useHeaderSlot(right);
  const custom = Boolean(subtitle) || (title != null && typeof title !== "string");
  const hasRight = Boolean(right);
  // The action's press always reaches its latest handler; the options change only with its word and state.
  const press = useRef(action?.onPress);
  useLayoutEffect(() => {
    press.current = action?.onPress;
  });
  const word = action?.label ?? null;
  const wordOff = action?.disabled ?? false;
  // Stable options: `setOptions` runs when the title, subtitle or the presence of actions change, not on
  // every render of the screen (a conversation re-renders while agents stream).
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...(plate ? coverBarOptions : solid ? {} : scrollUnder),
      ...(barTone && !plate ? { headerStyle: { backgroundColor: barTone } } : null),
      title: text,
      headerTitle: custom ? () => <HeaderTitle text={text} node={titleNode} subtitle={subtitle} /> : text,
      ...(word !== null && IOS
        ? {
            unstable_headerRightItems: () => [
              {
                type: "button" as const,
                label: word,
                accessibilityLabel: word,
                variant: liquidGlass ? ("prominent" as const) : ("done" as const),
                disabled: wordOff,
                onPress: () => press.current?.(),
              },
            ],
          }
        : null),
      headerRight: hasRight
        ? () => (
            <View style={styles.headerRight}>
              <HeaderCapsule>
                <HeaderSlot slot={rightNode} />
              </HeaderCapsule>
            </View>
          )
        : word !== null && !IOS
          ? () => (
              <View style={styles.headerRight}>
                <Button
                  size="sm"
                  variant="primary"
                  label={word}
                  disabled={wordOff}
                  onPress={() => press.current?.()}
                />
              </View>
            )
          : undefined,
    }),
    [plate, solid, scrollUnder, barTone, text, custom, subtitle, titleNode, hasRight, rightNode, word, wordOff],
  );
  return <Stack.Screen options={options} />;
}

/** A word on the right of a pushed screen's bar that saves (`PushedHeader`'s `action`). */
export interface HeaderWordAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/** A title with a subtitle under it, in the native bar (centered on iOS, leading on Android). */
function HeaderTitle({ text, node, subtitle }: { text: string; node: HeaderSlotStore; subtitle?: string | undefined }) {
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.headerTitle, { maxWidth: width - 150 }]}>
      {text ? (
        <Text variant="body" numberOfLines={1} style={styles.titleText}>
          {text}
        </Text>
      ) : (
        <HeaderSlot slot={node} />
      )}
      {subtitle ? (
        <Text variant="caption" tone="faint" numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
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

/** Didn't work: a connection that failed. */
export const errorHaptic = () => haptics.error();

/** Puts a text on the clipboard; resolves false when the system refused. */
export function copyText(text: string): Promise<boolean> {
  return Clipboard.setStringAsync(text).then(
    (ok) => ok !== false,
    () => false,
  );
}

/** Code only (branches, commands). */
export const MONO = fonts.mono;

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center" },
  action: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  actionText: { flex: 1, minWidth: 0 },
  mono: { fontFamily: MONO, fontSize: 13 },
  headerTitle: { alignItems: Platform.OS === "ios" ? "center" : "flex-start", minWidth: 0 },
  titleText: { fontWeight: "600" },
  headerRight: { flexDirection: "row", alignItems: "center" },
});

/**
 * A raised, neutral surface (the cards inside messages): raised background, the e1 shadow (e2 for what
 * asks for you: an approval) and lit top edge.
 */
export function useSurface(elevation: "e1" | "e2" = "e1") {
  const { colors, shadows } = useTheme();
  return useMemo(
    () => ({ backgroundColor: colors.raised, boxShadow: `${shadows[elevation]}, ${shadows.top}` }),
    [colors.raised, shadows, elevation],
  );
}

/** Agents inside stop moving while the screen is not showing (another screen is on top). */
export function FocusLive({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  return <LivePause paused={!focused}>{children}</LivePause>;
}
