import type { ReactNode } from "react";
import { Pressable, type PressableProps, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { useTheme } from "./theme";

/** The avatar column of a full-width list row (52pt: an agent's body, a person's photo, a tile). */
export const LIST_AVATAR = 52;
/** Where the hairline between rows starts: the text column. */
export const LIST_INSET = 14 + LIST_AVATAR + 12;

export interface ListRowProps extends Omit<PressableProps, "style" | "children"> {
  /** The 52pt avatar box's content. */
  leading: ReactNode;
  /** Line 1 (a string is drawn as the bold name). */
  title: ReactNode;
  /** Lines of the title (default 1). */
  titleLines?: number;
  /** On the right of line 1 (the time, faint). */
  time?: string | null;
  /** Line 2 (a string is drawn muted, up to two lines). */
  sub?: ReactNode;
  /** On the right of line 2 (a count badge, a state). */
  trailing?: ReactNode;
  /** A hairline above, inset to the text column (every row but the first). */
  divider?: boolean;
  /** A small ink dot left of the avatar (unread). */
  dot?: boolean;
}

/**
 * One full-width row of a list (MobileConversas.html): no card, the 52pt avatar, the bold name and the time
 * on line 1, the muted text (two lines) with a badge or state on line 2, hairlines inset to the text.
 * Used by Atividade; Conversas' row has the same metrics.
 */
export function ListRow({
  leading,
  title,
  titleLines = 1,
  time,
  sub,
  trailing,
  divider = false,
  dot = false,
  ...press
}: ListRowProps) {
  const { colors: c } = useTheme();
  return (
    <Pressable {...press} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      {dot ? <View style={[styles.dot, { backgroundColor: c.ink }]} /> : null}
      <View style={styles.avatar}>{leading}</View>
      <View style={styles.tx}>
        <View style={styles.l1}>
          {typeof title === "string" ? (
            <Text variant="title" numberOfLines={titleLines} style={styles.shrink}>
              {title}
            </Text>
          ) : (
            <View style={styles.shrink}>{title}</View>
          )}
          <View style={styles.grow} />
          {time ? (
            <Text variant="small" tone="faint" style={styles.time}>
              {time}
            </Text>
          ) : null}
        </View>
        {sub || trailing ? (
          <View style={styles.l2}>
            <View style={styles.grow}>
              {typeof sub === "string" ? (
                <Text variant="small" tone="muted" numberOfLines={2} style={styles.last}>
                  {sub}
                </Text>
              ) : (
                sub
              )}
            </View>
            {trailing}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 16,
    minHeight: 76,
  },
  divider: { position: "absolute", top: 0, left: LIST_INSET, right: 0, height: StyleSheet.hairlineWidth },
  dot: { position: "absolute", left: 3, top: "50%", marginTop: -4, width: 8, height: 8, borderRadius: 4 },
  avatar: { width: LIST_AVATAR, height: LIST_AVATAR, alignItems: "center", justifyContent: "center" },
  tx: { flex: 1, minWidth: 0, gap: 1 },
  l1: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  l2: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  time: { paddingTop: 1 },
  last: { lineHeight: 20 },
});
