import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { useInfoHint } from "./InfoHint";
import { Text, textLineOf } from "./Text";
import { ToggleSwitch } from "./Toggle";
import { useTheme } from "./theme";
import { leadBox } from "./type-scale";

/**
 * Settings as on the iPhone: grouped inset lists, radius 14, hairlines inset to
 * the text, an uppercase faint header above and a faint footer below. With no
 * rows it draws nothing, never an empty card.
 */
export function GroupedList({ children }: { children?: ReactNode }) {
  const { colors: c, shadows } = useTheme();
  const items = Children.toArray(children).filter(isValidElement);
  if (items.length === 0) return null;
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
  /** Lines the label may take (default 1): a setting's long name beside its switch. */
  labelLines?: number;
  /** A small line under the label. */
  sub?: string;
  /** Lines the small line may take (default 1). */
  subLines?: number;
  /** Under the small line, in the text column (a second line of facts). */
  below?: ReactNode;
  /** A line of facts under the small line, in faint, read out with the label (a `below` node is not). */
  belowText?: string;
  /** A rounded tile with this icon on the left. */
  icon?: IconName;
  /** Anything else on the left (an organization's tile). */
  leading?: ReactNode;
  /** The value on the right, faint ("Ligadas"). */
  value?: string;
  /** Drawn just before the value (a picked agent's face, a format's glyph). */
  valueLeading?: ReactNode;
  /** A chevron: it opens a screen. */
  chevron?: boolean;
  /** Three dots: it opens a sheet of actions. */
  more?: boolean;
  /** A checkmark: the chosen option. */
  checked?: boolean;
  /** A switch on the right (the whole row toggles). */
  toggle?: boolean;
  danger?: boolean;
  /** The label in faint: something listed that won't count. */
  faint?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  /** An ⓘ at the row's end: a tap on it shows the note under the row and never presses the row. */
  hint?: { name: string; text: string };
}

/** One row of a group: icon tile, label, the value in faint, a chevron, a check or a switch. */
export function GroupedRow(props: GroupedRowProps) {
  return props.hint ? <HintedRow {...props} hint={props.hint} /> : <Row {...props} />;
}

/** VoiceOver merges a button inside the row's button into it: the row reads the note out with its label. */
function HintedRow({ hint, ...props }: GroupedRowProps & { hint: { name: string; text: string } }) {
  // On the label's line: in a row whose text wraps the ⓘ stays beside the label, not at the row's top edge.
  const info = useInfoHint({ ...hint, variant: "body" });
  return (
    <View>
      <Row {...props} said={hint.text} after={info.button} />
      <View style={[styles.hint, info.open ? styles.hintOpen : null]}>{info.text}</View>
    </View>
  );
}

function Row({
  label,
  labelLines = 1,
  sub,
  subLines = 1,
  below,
  belowText,
  icon,
  leading,
  value,
  valueLeading,
  chevron = false,
  more = false,
  checked,
  toggle,
  danger = false,
  faint = false,
  disabled = false,
  onPress,
  said,
  after,
}: Omit<GroupedRowProps, "hint"> & { said?: string; after?: ReactNode }) {
  const { colors: c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const tone = danger ? c.danger : faint ? c.faint : c.ink;
  // Text that can take more than one line: the tile sits at the top and what is on the right stays on the
  // label's line (centred on the whole row it floated between lines). One-line rows keep everything centred.
  const tall = labelLines > 1 || subLines > 1 || Boolean(below) || Boolean(belowText);
  const line = tall ? textLineOf("body", fontScale) : null;
  const onLine = (size: number) => (line ? [leadBox(line, size), styles.onLine] : null);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole={toggle !== undefined ? "switch" : "button"}
      accessibilityLabel={[label, belowText, said, value].filter(Boolean).join(", ")}
      accessibilityState={{
        disabled,
        ...(toggle !== undefined ? { checked: toggle } : {}),
        ...(checked !== undefined ? { selected: checked } : {}),
      }}
      style={({ pressed }) => [
        styles.row,
        tall ? styles.tall : null,
        pressed && onPress ? { backgroundColor: c.sunken } : null,
      ]}
    >
      {icon ? (
        <View style={[styles.tile, { backgroundColor: danger ? c.plate : c.sunken }]}>
          <Icon name={icon} size={16} color={danger ? c.danger : c.ink2} />
        </View>
      ) : null}
      {leading}
      <View style={styles.grow}>
        <Text variant="body" numberOfLines={labelLines} style={{ color: tone }}>
          {label}
        </Text>
        {sub ? (
          <Text variant="footnote" tone="faint" numberOfLines={subLines}>
            {sub}
          </Text>
        ) : null}
        {below}
        {belowText ? (
          <Text variant="footnote" tone="faint" numberOfLines={2}>
            {belowText}
          </Text>
        ) : null}
      </View>
      {valueLeading ? (
        <View style={[styles.value, styles.valued, line ? { minHeight: line.height } : null]}>
          {valueLeading}
          {value ? (
            <Text variant="callout" tone="faint" numberOfLines={1} style={styles.shrink}>
              {value}
            </Text>
          ) : null}
        </View>
      ) : value ? (
        <View style={[styles.value, line ? { minHeight: line.height, justifyContent: "center" } : null]}>
          <Text variant="callout" tone="faint" numberOfLines={1}>
            {value}
          </Text>
        </View>
      ) : null}
      {after}
      {checked ? (
        <View style={onLine(18)}>
          <Icon name="check" size={18} color={c.ink} />
        </View>
      ) : null}
      {toggle !== undefined ? (
        <View style={onLine(28)}>
          <ToggleSwitch value={toggle} />
        </View>
      ) : null}
      {chevron ? (
        <View style={onLine(15)}>
          <Icon name="right" size={15} color={c.faint} />
        </View>
      ) : null}
      {more ? (
        <View style={onLine(18)}>
          <Icon name="more" size={18} color={c.faint} />
        </View>
      ) : null}
    </Pressable>
  );
}

interface GroupedFieldProps {
  label: string;
  /** An ⓘ right after the label, with the field's explanation. */
  hint?: { name: string; text: string };
  children: ReactNode;
  onPress?: () => void;
}

/**
 * A labeled field row ("Nome", "Seu @"): the label in a fixed column, the value or an input after it;
 * with `onPress`, the whole row opens a screen (a chevron on the right).
 */
export function GroupedField({ label, hint, children, onPress }: GroupedFieldProps) {
  const { colors: c } = useTheme();
  if (hint)
    return (
      <HintedField label={label} hint={hint} onPress={onPress}>
        {children}
      </HintedField>
    );
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

/**
 * A field whose label has an ⓘ. With `onPress` the row's button lies under the label and the value rather than
 * around them: inside another button the ⓘ would be part of it to VoiceOver, never a button of its own.
 */
function HintedField({ label, hint, children, onPress }: GroupedFieldProps & { hint: { name: string; text: string } }) {
  const { colors: c } = useTheme();
  const info = useInfoHint({ ...hint, variant: "callout" });
  const passive = onPress ? "none" : "auto";
  return (
    <View>
      <View style={styles.field}>
        {onPress ? (
          <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [StyleSheet.absoluteFill, pressed ? { backgroundColor: c.sunken } : null]}
          />
        ) : null}
        <View style={[styles.key, styles.keyLine]} pointerEvents="box-none">
          <View
            pointerEvents={passive}
            style={styles.shrink}
            accessibilityElementsHidden={Boolean(onPress)}
            importantForAccessibility={onPress ? "no-hide-descendants" : "auto"}
          >
            <Text variant="callout" tone="muted">
              {label}
            </Text>
          </View>
          {info.button}
        </View>
        <View style={styles.grow} pointerEvents={passive}>
          {children}
        </View>
        {onPress ? (
          <View pointerEvents="none">
            <Icon name="right" size={15} color={c.faint} />
          </View>
        ) : null}
      </View>
      <View style={[styles.hint, info.open ? styles.hintOpen : null]}>{info.text}</View>
    </View>
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
  // Wrapping text starts where a one-line row's label does (its 22 points centred in 50), not 8 from the top.
  tall: { alignItems: "flex-start", paddingVertical: 14 },
  // A control taller than the label's line (the 28-point switch) is centred on it rather than pushed below it.
  onLine: { justifyContent: "center" },
  tile: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  value: { flexShrink: 1, maxWidth: "50%" },
  valued: { flexDirection: "row", alignItems: "center", gap: 6 },
  field: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 50, paddingHorizontal: 14 },
  key: { width: 96 },
  keyLine: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  shrink: { flexShrink: 1, minWidth: 0 },
  hint: { paddingHorizontal: 14 },
  hintOpen: { paddingBottom: 12 },
});
