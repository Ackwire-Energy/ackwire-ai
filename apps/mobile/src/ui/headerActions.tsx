import type { NativeStackNavigationOptions } from "expo-router";
import type { SFSymbolIcon } from "expo-router/native-tabs";
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { IconButton } from "./IconButton";
import type { IconName } from "./icons.data";
import { HeaderSlot, useHeaderSlot } from "./navigation";

/** An SF Symbol name (the bar buttons on iOS). */
export type SFSymbolName = Extract<NonNullable<SFSymbolIcon["sf"]>, string>;

/** A button in a native header: the system bar button on iOS (glass on iOS 26), our icon button on Android. */
export interface HeaderAction {
  /** Our line icon (Android). */
  icon: IconName;
  /** The matching SF Symbol (iOS). */
  sf: SFSymbolName;
  label: string;
  onPress: () => void;
}

const IOS = Platform.OS === "ios";

/**
 * Header options for a screen's actions. On iOS the right actions are native `UIBarButtonItem`s
 * (`unstable_headerRightItems`): UIKit places, sizes and groups them in the bar, where a React view in
 * `headerRight` could be laid out in the wrong place on iOS 26. `left` is a custom element (the avatar on
 * Início), shown without the shared glass behind it. On Android both are React views in the bar.
 * The options only change when the actions' icons or labels change; presses always reach the latest
 * handlers.
 */
export function useHeaderActionOptions({
  right,
  left,
}: {
  right?: HeaderAction[] | undefined;
  left?: ReactNode;
}): NativeStackNavigationOptions {
  const latest = useRef(right);
  useLayoutEffect(() => {
    latest.current = right;
  });
  const leftSlot = useHeaderSlot(left ?? null);
  const hasLeft = left != null;
  const signature = JSON.stringify((right ?? []).map(({ icon, sf, label }) => ({ icon, sf, label })));
  return useMemo<NativeStackNavigationOptions>(() => {
    const actions = JSON.parse(signature) as Omit<HeaderAction, "onPress">[];
    const press = (i: number) => () => latest.current?.[i]?.onPress();
    const options: NativeStackNavigationOptions = {};
    if (IOS) {
      options.unstable_headerRightItems = actions.length
        ? () =>
            actions.map((a, i) => ({
              type: "button" as const,
              label: a.label,
              accessibilityLabel: a.label,
              icon: { type: "sfSymbol" as const, name: a.sf },
              onPress: press(i),
            }))
        : undefined;
      options.unstable_headerLeftItems = hasLeft
        ? () => [{ type: "custom" as const, element: <HeaderSlot slot={leftSlot} />, hidesSharedBackground: true }]
        : undefined;
    } else {
      options.headerRight = actions.length
        ? () => (
            <View style={styles.row}>
              {actions.map((a, i) => (
                <IconButton key={`${a.icon}:${a.label}`} icon={a.icon} label={a.label} onPress={press(i)} />
              ))}
            </View>
          )
        : undefined;
      options.headerLeft = hasLeft ? () => <HeaderSlot slot={leftSlot} /> : undefined;
    }
    return options;
  }, [signature, hasLeft, leftSlot]);
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
});
