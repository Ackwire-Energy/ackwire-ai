import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Alert, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { useColors } from "../shared/hooks";
import { copyText, type HeaderWordAction, MONO, PushedHeader, successHaptic } from "../shared/parts";

/**
 * What the workspace's settings screens share (each one a screen pushed with the platform's push, as Você's): the
 * page on the grouped gray under the native bar, the system's action list and confirmation (the web's menus and
 * dialogs), a terminal command with Copiar, and a progress bar.
 */

/** How long "Copiado" stays on a command's copy row. */
const COPIED_MS = 1800;

/**
 * A settings screen: the native bar (back, the title, a line under it, a word that saves on the right) over the
 * grouped gray, which scrolls under it.
 */
export function SettingsPage({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  action?: HeaderWordAction;
  children?: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={title}
        {...(subtitle ? { subtitle } : {})}
        solid={false}
        grouped
        {...(action ? { action } : {})}
      />
      <ScrollView
        style={styles.fill}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.body, { paddingBottom: 24 + insets.bottom }]}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** Space above a group that has no header. */
export function Gap() {
  return <View style={styles.gap} />;
}

export interface ActionChoice {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

/** A choice in the system's action list (the web's "…" menus). */
export function chooseAction(title: string, options: ActionChoice[], cancel: string) {
  if (Platform.OS === "ios") {
    const destructive = options.findIndex((o) => o.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...options.map((o) => o.label), cancel],
        cancelButtonIndex: options.length,
        ...(destructive >= 0 ? { destructiveButtonIndex: destructive } : {}),
      },
      (i) => options[i]?.onPress(),
    );
  } else {
    const buttons = options.map((o) => ({
      text: o.label,
      style: o.destructive ? ("destructive" as const) : undefined,
      onPress: o.onPress,
    }));
    // Android's alert holds three buttons at most: with three choices, a tap outside it cancels.
    Alert.alert(
      title,
      undefined,
      buttons.length < 3 ? [...buttons, { text: cancel, style: "cancel" as const }] : buttons.slice(0, 3),
      { cancelable: true },
    );
  }
}

/** The system's confirmation before something that can't be undone here (the web's confirm dialogs). */
export function confirmAction({
  title,
  text,
  action,
  cancel,
  destructive = true,
  onConfirm,
}: {
  title: string;
  text?: string | undefined;
  action: string;
  cancel: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  Alert.alert(title, text, [
    { text: cancel, style: "cancel" },
    { text: action, style: destructive ? "destructive" : "default", onPress: onConfirm },
  ]);
}

/**
 * A terminal command (or anything to paste), in mono (it is code), and Copiar under it; `copiedTitle`: the toast
 * ("Comando copiado. Cole no Terminal…" by default).
 */
export function CommandBlock({ command, copiedTitle }: { command: string; copiedTitle?: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <GroupedList>
      <View style={styles.command}>
        <Text selectable style={[styles.mono, { color: c.ink }]}>
          {command}
        </Text>
      </View>
      <GroupedRow
        icon={copied ? "check" : "copy"}
        label={copied ? t("common.copied") : t("common.copy")}
        onPress={() =>
          void copyText(command).then((ok) => {
            if (!ok) return;
            successHaptic();
            setCopied(true);
            toast({ title: copiedTitle ?? t("machines.commandCopied"), icon: "copy" });
          })
        }
      />
    </GroupedList>
  );
}

/** How far something went (a copy of files): a sunken track, the part done in ink. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const c = useColors();
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max, now: value }}
      style={[styles.track, { backgroundColor: c.sunken }]}
    >
      <View style={[styles.done, { width: `${share * 100}%`, backgroundColor: c.ink }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 4 },
  gap: { height: 14 },
  command: { paddingHorizontal: 14, paddingVertical: 12 },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  done: { height: 6, borderRadius: 3 },
});
