import { openBrowserAsync } from "expo-web-browser";
import type { ReactNode } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { Button, Icon, type IconName, Text } from "@/ui";
import { useColors } from "../shared/hooks";

/**
 * The pieces the web's AI panels are made of (`SettingNote`, the numbered `Step`, `OpenPage`), on the phone.
 */

/** A line with its icon (the web's `SettingNote`): why something waits, what is safe, what went wrong. */
export function Note({ icon, children, live = false }: { icon: IconName; children: ReactNode; live?: boolean }) {
  const c = useColors();
  return (
    <View style={styles.note} accessibilityLiveRegion={live ? "polite" : undefined}>
      <Icon name={icon} size={15} color={icon === "x" ? c.danger : c.muted} />
      <Text variant="small" tone={icon === "x" ? "danger" : "muted"} style={styles.grow}>
        {children}
      </Text>
    </View>
  );
}

/**
 * A numbered step: its number on the title's line, the words under it, its button under them (the web at phone
 * width: the button goes in the words' column).
 */
export function Step({
  n,
  title,
  children,
  side,
}: {
  n: number;
  title: string;
  children?: ReactNode;
  side?: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={styles.step}>
      <View style={[styles.n, { backgroundColor: c.ink }]}>
        <Text variant="caption" style={[styles.nText, { color: c.bg }]}>
          {n}
        </Text>
      </View>
      <View style={styles.text}>
        <Text variant="subhead" tone="ink" style={styles.bold}>
          {title}
        </Text>
        {children}
        {side ? <View style={styles.side}>{side}</View> : null}
      </View>
    </View>
  );
}

/** A step's quiet words (13 on the web). */
export function StepText({ children }: { children: ReactNode }) {
  return (
    <Text variant="small" tone="muted">
      {children}
    </Text>
  );
}

/** Opens a maker's own page (a sign-in, its settings, where a key is made) in the in-app browser. */
export function openPage(href: string) {
  void openBrowserAsync(href).catch(() => Linking.openURL(href));
}

/** The web's `OpenPage`: a small button with the external mark. */
export function OpenPage({
  href,
  label,
  primary = false,
  onOpened,
}: {
  href: string;
  label: string;
  primary?: boolean;
  onOpened?: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={primary ? "primary" : "secondary"}
      icon="out"
      label={label}
      onPress={() => {
        onOpened?.();
        openPage(href);
      }}
    />
  );
}

/** "Esperando…" beside a step that waits on the computer. */
export function Waiting({ label }: { label: string }) {
  const c = useColors();
  return (
    <View style={styles.wait} accessibilityLiveRegion="polite">
      <Icon name="clock" size={13} color={c.faint} />
      <Text variant="caption" tone="faint" style={styles.bold}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  n: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", marginTop: 1 },
  nText: { fontWeight: "700", fontSize: 11, lineHeight: 13 },
  text: { flex: 1, minWidth: 0, gap: 4 },
  bold: { fontWeight: "600" },
  side: { marginTop: 4, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  wait: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
});
