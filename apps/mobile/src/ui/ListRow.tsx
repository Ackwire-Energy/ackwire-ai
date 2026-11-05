import type { ReactNode } from "react";
import { Platform, Pressable, type PressableProps, StyleSheet, type TextStyle, View } from "react-native";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { weights } from "./type-scale";

/** The avatar column of a full-width list row (52pt: an agent's body, a person's photo, a tile). */
export const LIST_AVATAR = 52;
/** The gap between the avatar and the text. */
const GAP = 13;
/** Where the hairline between rows starts: the text column. */
export const LIST_INSET = 14 + LIST_AVATAR + GAP;

const IOS = Platform.OS === "ios";

/**
 * A row's second line, readable: 15.5/21 on iOS (Android keeps its
 * 14/20 body medium). For any text that sits in that line (a preview, what an agent is doing).
 */
export const LIST_PREVIEW: TextStyle = IOS ? { fontSize: 15.5, lineHeight: 21 } : { lineHeight: 20 };
/** The time on line 1: 14.5 on iOS, tabular figures. */
export const LIST_TIME: TextStyle = { ...(IOS ? { fontSize: 14.5 } : null), fontVariant: ["tabular-nums"] };

export interface ListRowProps extends Omit<PressableProps, "style" | "children"> {
  /** The 52pt avatar box's content. */
  leading: ReactNode;
  /** Line 1 (a string is drawn as the semibold name; bold when unread). */
  title: ReactNode;
  /** Lines of the title (default 1). */
  titleLines?: number;
  /** On the right of line 1 (the time, faint; darker when unread). */
  time?: string | null;
  /** A small faint line under the title (what and where: "Missão · #canal"). */
  over?: ReactNode;
  /** Line 2 (a string is drawn in the readable secondary color, up to two lines). */
  sub?: ReactNode;
  /** Lines of a string `sub` (default 2, 0: all of it). */
  subLines?: number;
  /** On the right of line 2 (a count badge, a state). */
  trailing?: ReactNode;
  /** A hairline above, inset to the text column (every row but the first). */
  divider?: boolean;
  /** A red dot on the right, centered on the row (unread), as messaging apps do. */
  dot?: boolean;
  /** Something new in it: the name bold, the time and the preview darker. */
  unread?: boolean;
  /** The row's own background (in a white card on grouped gray: `raised`). Default: clear. */
  background?: string;
}

/**
 * One full-width row of a list: no card, the
 * 52pt avatar, the semibold 17 name and the time on line 1, the preview (15.5/21, two lines) with a badge or
 * state on line 2, hairlines inset to the text, about 82pt tall. Unread: bold name, darker time and preview.
 * Conversas, Atividade and Agentes use it.
 */
export function ListRow({
  leading,
  title,
  titleLines = 1,
  time,
  over,
  sub,
  subLines = 2,
  trailing,
  divider = false,
  dot = false,
  unread = false,
  background,
  ...press
}: ListRowProps) {
  const { colors: c } = useTheme();
  return (
    <Pressable
      {...press}
      style={({ pressed }) => [
        styles.row,
        background ? { backgroundColor: background } : null,
        pressed && { backgroundColor: c.sunken },
      ]}
    >
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <View style={styles.avatar}>{leading}</View>
      <View style={styles.tx}>
        <View style={styles.l1}>
          {typeof title === "string" ? (
            <Text variant="title" numberOfLines={titleLines} style={[styles.shrink, unread && styles.unreadName]}>
              {title}
            </Text>
          ) : (
            <View style={styles.shrink}>{title}</View>
          )}
          {time ? (
            <Text
              variant="small"
              tone={unread ? "ink2" : "faint"}
              style={[styles.time, LIST_TIME, unread && styles.unreadTime]}
            >
              {time}
            </Text>
          ) : null}
        </View>
        {over}
        {sub || trailing ? (
          <View style={styles.l2}>
            <View style={styles.grow}>
              {typeof sub === "string" ? (
                <Text variant="small" tone={unread ? "ink2" : "muted"} numberOfLines={subLines} style={LIST_PREVIEW}>
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
      {dot ? <View style={[styles.dot, { backgroundColor: c.badge }]} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: GAP,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 16,
    minHeight: 82,
  },
  divider: { position: "absolute", top: 0, left: LIST_INSET, right: 0, height: StyleSheet.hairlineWidth },
  dot: { width: 10, height: 10, borderRadius: 5, marginLeft: -3 },
  avatar: { width: LIST_AVATAR, height: LIST_AVATAR, alignItems: "center", justifyContent: "center" },
  tx: { flex: 1, minWidth: 0, gap: 2 },
  // The time sits on the name's baseline, on its first line when it wraps: never centered beside two lines.
  l1: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  l2: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  unreadName: { fontWeight: weights.bold },
  time: { flexShrink: 0, marginLeft: "auto" },
  unreadTime: { fontWeight: weights.medium },
});
