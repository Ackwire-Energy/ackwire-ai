import { parseChart } from "@agenteschat/client/lib/chart";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { Text as RNText, StyleSheet, View } from "react-native";
import { Text, useReducedMotion } from "@/ui";
import { useColors } from "../shared/hooks";
import { ChartCard, ChartPending } from "./ChartCard";
import { CodeCard } from "./CodeCard";
import { parseBlocks } from "./logic";
import { Spans, Table } from "./MessageSpans";

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
  accent,
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
  /** The writing agent's color: its charts take its tones. */
  accent?: AgentColorName;
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
                <Fenced lang={b.lang} text={b.text} accent={accent} open={b.open === true} />
                {/* A block still being written takes no fading tail or caret: its card grows instead. */}
                {end && !b.open ? <Text variant="body">{end}</Text> : null}
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

/**
 * A fenced block: a ```chart that reads as one is drawn; one still being written shows "Montando o
 * gráfico…"; anything else is a code card (growing while it is written).
 */
function Fenced({ lang, text, accent, open }: { lang: string; text: string; accent?: AgentColorName; open: boolean }) {
  const isChart = lang.toLowerCase() === "chart";
  const chart = useMemo(() => (isChart && !open ? parseChart(text) : null), [isChart, open, text]);
  if (chart) return <ChartCard spec={chart} {...(accent ? { accent } : {})} />;
  if (isChart && open) return <ChartPending {...(accent ? { accent } : {})} />;
  return <CodeCard lang={isChart ? "json" : lang} text={text} />;
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
});
