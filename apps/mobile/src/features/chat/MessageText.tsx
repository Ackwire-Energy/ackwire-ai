import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { Text as RNText, ScrollView, StyleSheet, View } from "react-native";
import { Text, useReducedMotion } from "@/ui";
import { useColors } from "../shared/hooks";
import { MONO } from "../shared/parts";
import { CodeCard } from "./CodeCard";
import { type Block, type Inline, parseBlocks } from "./logic";

/**
 * A message's text: paragraphs, lists, quotes, headings, bold, italic,
 * @mentions and code (mono only for code). While an agent writes, its
 * thin caret blinks at the end, after the words still fading in (`tail`).
 */
export const MessageText = memo(function MessageText({
  body,
  streaming = false,
  tail,
  muted = false,
  selectable = true,
}: {
  body: string;
  streaming?: boolean;
  /** The newest words, fading in, at the end of the last block (plain text only). */
  tail?: ReactNode;
  muted?: boolean;
  /**
   * false in chat rows: a long press there opens the message sheet (which has "Copiar texto"), and native
   * selection would float iOS's own "Copiar" bubble over it.
   */
  selectable?: boolean;
}) {
  const c = useColors();
  const blocks = useMemo(() => parseBlocks(body), [body]);
  const tone = muted ? "muted" : "ink";
  const last = blocks.length - 1;
  const caret =
    streaming || tail ? (
      <>
        {tail}
        {streaming ? <Caret /> : null}
      </>
    ) : null;
  return (
    <View style={styles.wrap}>
      {blocks.map((b, i) => {
        const end = i === last ? caret : null;
        switch (b.kind) {
          case "code":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i}>
                <CodeCard lang={b.lang} text={b.text} />
                {end ? <Text variant="body">{end}</Text> : null}
              </View>
            );
          case "table":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i}>
                <Table header={b.header} rows={b.rows} align={b.align} />
                {end ? <Text variant="body">{end}</Text> : null}
              </View>
            );
          case "heading":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <Text key={i} variant="body" tone="ink" style={[styles.line, styles.heading]}>
                <Spans inline={b.inline} />
                {end}
              </Text>
            );
          case "bullet":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={styles.bullet}>
                <Text variant="body" tone="faint" style={[styles.line, styles.mark]}>
                  {b.ordinal ? `${b.ordinal}.` : "•"}
                </Text>
                <Text variant="body" tone={tone} style={[styles.line, styles.flex]}>
                  <Spans inline={b.inline} />
                  {end}
                </Text>
              </View>
            );
          case "quote":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={[styles.quote, { borderLeftColor: c.line2 ?? c.line }]}>
                <Text variant="body" tone="muted" style={styles.line}>
                  <Spans inline={b.inline} />
                  {end}
                </Text>
              </View>
            );
          default:
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <Text key={i} variant="body" tone={tone} style={styles.line} selectable={selectable}>
                <Spans inline={b.inline} />
                {end}
              </Text>
            );
        }
      })}
      {blocks.length === 0 && caret ? <Text variant="body">{caret}</Text> : null}
    </View>
  );
});

function Spans({ inline }: { inline: Inline[] }) {
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
function Table({ header, rows, align }: Pick<TableBlock, "header" | "rows" | "align">) {
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

/** The agent's thin caret while it writes (agent blue: the agent's identity); still with reduce motion. */
function Caret() {
  const c = useColors();
  const reduce = useReducedMotion();
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (reduce) {
      setOn(true);
      return;
    }
    const timer = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(timer);
  }, [reduce]);
  return <RNText style={{ color: c.agent, opacity: on ? 1 : 0 }}>{"\u2009▏"}</RNText>;
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginTop: 1 },
  /** Readable turns: 17 with a line-height of ~1.42. */
  line: { lineHeight: 24 },
  flex: { flex: 1 },
  heading: { fontWeight: "700" },
  bullet: { flexDirection: "row", gap: 8, paddingLeft: 2 },
  mark: { minWidth: 14 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  table: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  tr: { flexDirection: "row" },
  trLine: { borderTopWidth: StyleSheet.hairlineWidth },
  cell: { paddingHorizontal: 12, paddingVertical: 8 },
  cellText: { fontVariant: ["tabular-nums"] },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  inlineCode: { fontFamily: MONO, fontSize: 15 },
});
