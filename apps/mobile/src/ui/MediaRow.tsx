import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { MEDIA_ROW, type MediaRowSize } from "./media-row";
import { Text } from "./Text";
import { weights } from "./type-scale";

export interface MediaRowProps {
  /** The face, `MEDIA_ROW[size].face` square: an agent, a person, a maker's tile. */
  face: ReactNode;
  name: string;
  /** What it is, muted, after the name on its line (a role, "#129 · há 6 min"). */
  meta?: string;
  /** At the end of the name's line (a channel, a small action). */
  end?: ReactNode;
  /** Under the name's line, at the row's full width, 8 apart. */
  children?: ReactNode;
  /** `card` (face 32) in a card's head, `row` (face 24) in a list. */
  size?: MediaRowSize;
}

/** A face, the name and what it is on one line, and the rest under them at full width (the web's MediaRow). */
export function MediaRow({ face, name, meta, end, children, size = "card" }: MediaRowProps) {
  const { face: side, gap } = MEDIA_ROW[size];
  return (
    <View style={styles.row}>
      <View style={[styles.head, { gap }]}>
        <View style={{ width: side, height: side }}>{face}</View>
        <Text variant="subhead" style={styles.words}>
          <Text variant="subhead" style={styles.name}>
            {name}
          </Text>
          {meta ? (
            <Text variant="footnote" tone="muted">
              {` ${meta}`}
            </Text>
          ) : null}
        </Text>
        {end}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: MEDIA_ROW.under },
  head: { flexDirection: "row", alignItems: "center" },
  words: { flex: 1, minWidth: 0 },
  name: { fontWeight: weights.semibold },
});
