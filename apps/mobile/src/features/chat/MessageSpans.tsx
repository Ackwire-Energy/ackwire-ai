import { parseMessageLink } from "@agenteschat/client/lib/message-links";
import { useState } from "react";
import { Text as RNText, ScrollView, StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { Text } from "@/ui";
import { openPage } from "../ai/parts";
import { useColors, useMyHandle } from "../shared/hooks";
import { MONO } from "../shared/parts";
import { ChannelRefText } from "./ChannelRefText";
import type { Block, Inline } from "./logic";
import { MessageRefText } from "./MessageRefText";

/**
 * Inline marks of a message (bold, italic, `code`, links, a message's link as its pill, @mentions, #channels), inside a Text. `channelRefs`: the
 * message's `meta.channelRefs` (a renamed channel still links).
 */
export function Spans({ inline, channelRefs }: { inline: Inline[]; channelRefs?: Record<string, string> }) {
  const c = useColors();
  const myHandle = useMyHandle();
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
          case "link": {
            // A message here: its pill, opening it in the app.
            const message = parseMessageLink(s.href, [serverUrl()]);
            if (message) return <MessageRefText key={key} link={message} />;
            // Opens in the in-app browser; a press on a link wins over the row's long press.
            return (
              <RNText key={key} accessibilityRole="link" onPress={() => openPage(s.href)} style={styles.link}>
                {s.text}
              </RNText>
            );
          }
          case "channel":
            return <ChannelRefText key={key} name={s.name} text={s.text} refs={channelRefs} />;
          case "mention":
            return (
              <RNText
                key={key}
                style={[
                  styles.bold,
                  s.text.slice(1).toLowerCase() === myHandle
                    ? { color: c.amber, backgroundColor: `${c.amber}2e` }
                    : { color: c.ink },
                ]}
              >
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

/** A cell's text length: a column's first guess, until its cells have been measured. */
const cellLength = (cell: Inline[]) => cell.reduce((n, s) => n + s.text.length, 0);

/** Widest a column gets: a longer cell wraps inside it, at its words. */
const COL_MAX = 280;
const COL_MIN = 56;

/**
 * A table (the web's `md__table`): a quiet box with a hairline, the header on a soft band, rows split by
 * hairlines, numbers on the right in tabular figures. Each column is as wide as its widest cell as drawn (measured
 * on an unseen copy that never wraps, since a guess by letters came out narrow and broke words), up to `COL_MAX`;
 * a table wider than the message scrolls sideways inside its box.
 */
export function Table({ header, rows, align }: Pick<TableBlock, "header" | "rows" | "align">) {
  const c = useColors();
  const [drawn, setDrawn] = useState<Record<number, number>>({});
  const widths = header.map((h, col) => {
    const natural = drawn[col] ?? Math.max(cellLength(h), ...rows.map((r) => cellLength(r[col] ?? []))) * 8.6 + 24;
    // A pixel more than measured: rounding never wraps a cell that fits.
    return Math.min(COL_MAX, Math.max(COL_MIN, Math.ceil(natural) + 1));
  });
  const words = (inline: Inline[], col: number, head: boolean) => (
    <Text
      variant={head ? "label" : "subhead"}
      tone={head ? "muted" : "ink"}
      style={[styles.cellText, { textAlign: align[col] ?? "left" }]}
    >
      <Spans inline={inline} />
    </Text>
  );
  const cell = (inline: Inline[], col: number, head: boolean) => (
    <View key={col} style={[styles.cell, { width: widths[col] }]}>
      {words(inline, col, head)}
    </View>
  );
  return (
    <View>
      {/* Each column's cells unseen, on a sideways strip with no width to wrap them: their widths. */}
      <View
        pointerEvents="none"
        style={styles.measure}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <ScrollView horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false}>
          {header.map((h, col) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: the columns of one table, in order
              key={col}
              onLayout={(e) => {
                const w = e.nativeEvent.layout.width;
                setDrawn((d) => (d[col] === w ? d : { ...d, [col]: w }));
              }}
            >
              {[h, ...rows.map((r) => r[col] ?? [])].map((inline, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the cells of one column, in order
                <View key={j} style={styles.cell}>
                  {words(inline, col, j === 0)}
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  table: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  measure: { position: "absolute", top: 0, left: 0, right: 0, opacity: 0 },
  tr: { flexDirection: "row" },
  trLine: { borderTopWidth: StyleSheet.hairlineWidth },
  cell: { paddingHorizontal: 12, paddingVertical: 8 },
  cellText: { fontVariant: ["tabular-nums"] },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  link: { textDecorationLine: "underline" },
  inlineCode: { fontFamily: MONO, fontSize: 15 },
});
