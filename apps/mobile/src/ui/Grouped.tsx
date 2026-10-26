import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";
import { ToggleSwitch } from "./Toggle";
import { useTheme } from "./theme";

/**
 * Settings as on the iPhone: grouped inset lists, radius 14, hairlines inset to
 * the text, an uppercase faint header above and a faint footer below.
 */
export function GroupedList({ children }: { children?: ReactNode }) {
  const { colors: c, shadows } = useTheme();
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View style={[styles.list, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}>
      {items.map((child, i) => (
        <Fragment key={child.key ?? i}>
          {i > 0 ? (
            <View
              style={[
                styles.divider,
                {
                  backgroundColor: c.line2,
                  marginLeft: (child.props as { icon?: unknown; leading?: unknown }).icon
                    ? 54
                    : (child.props as { leading?: unknown }).leading
                      ? 58
                      : 14,
                },
              ]}
            />
          ) : null}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

/** The small uppercase header of a group. */
export function GroupedHeader({ children }: { children: string }) {
  return (
    <Text variant="footnote" tone="faint" accessibilityRole="header" style={styles.header}>
      {children.toLocaleUpperCase()}
    </Text>
  );
}

/** The faint explanation under a group. */
export function GroupedFooter({ children }: { children: ReactNode }) {
  return (
    <Text variant="footnote" tone="faint" style={styles.footer}>
      {children}
    </Text>
  );
}

export interface GroupedRowProps {
  label: string;
  /** A small line under the label. */
  sub?: string;
  /** Lines the small line may take (default 1). */
  subLines?: number;
  /** A rounded tile with this icon on the left. */
  icon?: IconName;
  /** Anything else on the left (an organization's tile). */
  leading?: ReactNode;
  /** The value on the right, faint ("Ligadas"). */
  value?: string;
  /** A chevron: it opens a screen. */
  chevron?: boolean;
  /** A checkmark: the chosen option. */
  checked?: boolean;
  /** A switch on the right (the whole row toggles). */
  toggle?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}

/** One row of a group: icon tile, label, the value in faint, a chevron, a check or a switch. */
export function GroupedRow({
  label,
  sub,
  subLines = 1,
  icon,
  leading,
  value,
  chevron = false,
  checked,
  toggle,
  danger = false,
  disabled = false,
  onPress,
}: GroupedRowProps) {
  const { colors: c } = useTheme();
  const tone = danger ? c.danger : c.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole={toggle !== undefined ? "switch" : "button"}
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityState={{
        disabled,
        ...(toggle !== undefined ? { checked: toggle } : {}),
        ...(checked !== undefined ? { selected: checked } : {}),
      }}
      style={({ pressed }) => [styles.row, pressed && onPress ? { backgroundColor: c.sunken } : null]}
    >
      {icon ? (
        <View style={[styles.tile, { backgroundColor: danger ? c.plate : c.sunken }]}>
          <Icon name={icon} size={16} color={danger ? c.danger : c.ink2} />
        </View>
      ) : null}
      {leading}
      <View style={styles.grow}>
        <Text variant="body" numberOfLines={1} style={{ color: tone }}>
          {label}
        </Text>
        {sub ? (
          <Text variant="footnote" tone="faint" numberOfLines={subLines}>
            {sub}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text variant="callout" tone="faint" numberOfLines={1} style={styles.value}>
          {value}
        </Text>
      ) : null}
      {checked ? <Icon name="check" size={18} color={c.ink} /> : null}
      {toggle !== undefined ? <ToggleSwitch value={toggle} /> : null}
      {chevron ? <Icon name="right" size={15} color={c.faint} /> : null}
    </Pressable>
  );
}

/**
 * A labeled field row ("Nome", "Seu @"): the label in a fixed column, the value or an input after it;
 * with `onPress`, the whole row opens a screen (a chevron on the right).
 */
export function GroupedField({
  label,
  children,
  onPress,
}: {
  label: string;
  children: ReactNode;
  onPress?: () => void;
}) {
  const { colors: c } = useTheme();
  const body = (
    <>
      <Text variant="callout" tone="muted" style={styles.key}>
        {label}
      </Text>
      <View style={styles.grow}>{children}</View>
      {onPress ? <Icon name="right" size={15} color={c.faint} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.field}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.field, pressed ? { backgroundColor: c.sunken } : null]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { borderRadius: 14, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth },
  header: { paddingTop: 18, paddingBottom: 7, paddingHorizontal: 16, letterSpacing: 0.4 },
  footer: { paddingTop: 7, paddingHorizontal: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 50,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  tile: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  value: { flexShrink: 1, maxWidth: "50%" },
  field: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 50, paddingHorizontal: 14 },
  key: { width: 96 },
});
