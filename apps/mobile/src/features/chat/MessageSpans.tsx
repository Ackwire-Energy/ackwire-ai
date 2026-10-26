import { Text as RNText, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { MONO } from "../shared/parts";
import type { Block, Inline } from "./logic";

/** Inline marks of a message (bold, italic, `code`, @mentions), inside a Text. */
export function Spans({ inline }: { inline: Inline[] }) {
  const c = useColors();
  return (
    <>
      {inline.map((s, i) => {
        const key = `${i}-${s.kind}`;
        switch (s.kind) {
          case "bold":
            return (
              <RNText key={key} style={styles.bold}>
                {s.text}
              </RNText>
            );
          case "italic":
            return (
              <RNText key={key} style={styles.italic}>
                {s.text}
              </RNText>
            );
          case "code":
            return (
              <RNText key={key} style={[styles.inlineCode, { backgroundColor: c.sunken, color: c.ink2 }]}>
                {s.text}
              </RNText>
            );
          case "mention":
            return (
              <RNText key={key} style={[styles.bold, { color: c.ink }]}>
                {s.text}
              </RNText>
            );
          default:
            return <RNText key={key}>{s.text}</RNText>;
        }
      })}
    </>
  );
}

type TableBlock = Extract<Block, { kind: "table" }>;

/** A cell's text length, for its column's width (the app has no table layout). */
const cellLength = (cell: Inline[]) => cell.reduce((n, s) => n + s.text.length, 0);

/**
 * A table (the web's `md__table`): a quiet box with a hairline, the header on a soft band, rows split by
 * hairlines, numbers on the right in tabular figures. Columns are as wide as their longest cell (within
 * bounds); a wide table scrolls sideways inside its box.
 */
export function Table({ header, rows, align }: Pick<TableBlock, "header" | "rows" | "align">) {
  const c = useColors();
  const widths = header.map((h, col) => {
    const longest = Math.max(cellLength(h), ...rows.map((r) => cellLength(r[col] ?? [])));
    return Math.min(240, Math.max(56, longest * 8.6 + 24));
  });
  const cell = (inline: Inline[], col: number, head: boolean) => (
    <View key={col} style={[styles.cell, { width: widths[col] }]}>
      <Text
        variant={head ? "label" : "subhead"}
        tone={head ? "muted" : "ink"}
        style={[styles.cellText, { textAlign: align[col] ?? "left" }]}
      >
        <Spans inline={inline} />
      </Text>
    </View>
  );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.table, { borderColor: c.line2 ?? c.line }]}
    >
      <View>
        <View style={[styles.tr, { backgroundColor: c.plate }]}>{header.map((h, col) => cell(h, col, true))}</View>
        {rows.map((r, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one table, in order
          <View key={j} style={[styles.tr, { borderTopColor: c.line }, styles.trLine]}>
            {header.map((_, col) => cell(r[col] ?? [], col, false))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  table: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  tr: { flexDirection: "row" },
  trLine: { borderTopWidth: StyleSheet.hairlineWidth },
  cell: { paddingHorizontal: 12, paddingVertical: 8 },
  cellText: { fontVariant: ["tabular-nums"] },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  inlineCode: { fontFamily: MONO, fontSize: 15 },
});
