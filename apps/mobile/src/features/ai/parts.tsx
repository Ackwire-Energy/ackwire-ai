import { openBrowserAsync } from "expo-web-browser";
import type { ReactElement, ReactNode } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { Button, Icon, type IconName, Text, useTheme } from "@/ui";
import { useColors } from "../shared/hooks";

/**
 * The pieces the web's AI panels are made of (`SettingNote`, the numbered `Step`, `OpenPage`), on the phone.
 */

/**
 * A line with its icon (the web's `SettingNote`): why something waits, what is safe, what went wrong. `icon` may be
 * a mark of its own, 15 pt (the orbit of work under way).
 */
export function Note({
  icon,
  children,
  live = false,
}: {
  icon: IconName | ReactElement;
  children: ReactNode;
  live?: boolean;
}) {
  const c = useColors();
  return (
    <View style={styles.note} accessibilityLiveRegion={live ? "polite" : undefined}>
      {typeof icon === "string" ? <Icon name={icon} size={15} color={icon === "x" ? c.danger : c.muted} /> : icon}
      <Text variant="small" tone={icon === "x" ? "danger" : "muted"} style={styles.grow}>
        {children}
      </Text>
    </View>
  );
}

/** The steps' white card (a grouped list of numbered rows). */
export function StepsCard({ children }: { children: ReactNode }) {
  const { colors: c, shadows } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}>
      {children}
    </View>
  );
}

/**
 * A numbered step, one row of the steps' card: its number (a check once `done`, faint while it waits), the title,
 * the words under it and its buttons under them. `divider`: a hairline above it, inset to the words.
 */
export function Step({
  n,
  title,
  children,
  side,
  divider = false,
  state = "now",
}: {
  n: number;
  title: string;
  children?: ReactNode;
  side?: ReactNode;
  divider?: boolean;
  state?: "now" | "done" | "later";
}) {
  const c = useColors();
  return (
    <View style={styles.step}>
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <View style={[styles.n, { backgroundColor: state === "done" ? c.ok : state === "later" ? c.plate : c.ink }]}>
        {state === "done" ? (
          <Icon name="check" size={12} color="#ffffff" />
        ) : (
          <Text variant="caption" style={[styles.nText, { color: state === "later" ? c.faint : c.bg }]}>
            {n}
          </Text>
        )}
      </View>
      <View style={styles.text}>
        <Text variant="callout" tone="ink" style={styles.bold}>
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
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 4 },
  grow: { flex: 1, minWidth: 0 },
  card: { borderRadius: 14, overflow: "hidden" },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  divider: { position: "absolute", top: 0, left: 48, right: 0, height: StyleSheet.hairlineWidth },
  n: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", marginTop: 1 },
  nText: { fontWeight: "700", fontSize: 12, lineHeight: 14 },
  text: { flex: 1, minWidth: 0, gap: 4 },
  bold: { fontWeight: "600" },
  side: { marginTop: 6, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  wait: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
});
