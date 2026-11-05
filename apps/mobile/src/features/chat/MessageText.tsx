import { parseChart } from "@agenteschat/client/lib/chart";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import { Icon, Text, useReducedMotion } from "@/ui";
import { useColors } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { ChartCard, ChartPending } from "./ChartCard";
import { CodeCard } from "./CodeCard";
import { type Inline, parseBlocks } from "./logic";
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
  channelRefs,
  everyone = false,
  ink,
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
  /** The message's `meta.channelRefs`: the channel each `#name` meant when written. */
  channelRefs?: Record<string, string>;
  /** The message's `meta.mentionsEveryone`: its `@todos` shows in the reader's language, like a mention of them. */
  everyone?: boolean;
  /** Over a solid bubble: the words' color in place of the page's. */
  ink?: string;
}) {
  const c = useColors();
  const blocks = useMemo(() => parseBlocks(body), [body]);
  const inked = ink ? { color: ink } : undefined;
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
                <View style={ink ? [styles.cut, { backgroundColor: c.bg }] : undefined}>
                  <Table header={b.header} rows={b.rows} align={b.align} />
                </View>
                {end ? <Text variant="body">{end}</Text> : null}
              </View>
            );
          case "heading":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <Text key={i} variant="body" tone="ink" style={[styles.line, styles.heading, inked]}>
                <Spans inline={b.inline} channelRefs={channelRefs} everyone={everyone} ink={ink} />
                {end}
              </Text>
            );
          case "bullet":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={styles.bullet}>
                <Text variant="body" tone="faint" style={[styles.line, styles.mark, inked]}>
                  {b.ordinal ? `${b.ordinal}.` : "•"}
                </Text>
                <Text variant="body" tone={tone} style={[styles.line, styles.flex, inked]}>
                  <Spans inline={b.inline} channelRefs={channelRefs} everyone={everyone} ink={ink} />
                  {end}
                </Text>
              </View>
            );
          case "details":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={ink ? [styles.cut, { backgroundColor: c.bg }] : undefined}>
                <Details summary={b.summary} body={b.body} muted={muted} accent={accent} channelRefs={channelRefs} />
                {end ? <Text variant="body">{end}</Text> : null}
              </View>
            );
          case "quote":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={[styles.quote, { borderLeftColor: ink ?? c.line2 ?? c.line }]}>
                <Text variant="body" tone="muted" style={[styles.line, inked]}>
                  <Spans inline={b.inline} channelRefs={channelRefs} everyone={everyone} ink={ink} />
                  {end}
                </Text>
              </View>
            );
          default:
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <Text key={i} variant="body" tone={tone} style={[styles.line, inked]} selectable={selectable}>
                <Spans inline={b.inline} channelRefs={channelRefs} everyone={everyone} ink={ink} />
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

/** A collapsed block (`<details>`, ADR 0147): its summary opens what only some want to read. */
function Details({
  summary,
  body,
  muted,
  accent,
  channelRefs,
}: {
  summary: Inline[];
  body: string;
  muted: boolean;
  accent?: AgentColorName;
  channelRefs?: Record<string, string>;
}) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.details, { borderColor: c.line }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          tapHaptic();
          setOpen((v) => !v);
        }}
        style={styles.summary}
      >
        <Text variant="body" tone="muted" style={[styles.line, styles.flex, styles.heading]}>
          {summary.length > 0 ? <Spans inline={summary} channelRefs={channelRefs} /> : "…"}
        </Text>
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={13} color={c.muted} />
        </View>
      </Pressable>
      {open ? (
        <MessageText
          body={body}
          muted={muted}
          {...(accent ? { accent } : {})}
          {...(channelRefs ? { channelRefs } : {})}
        />
      ) : null}
    </View>
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
  /** On a solid bubble: a table or a collapsed block stays on the page's color, in the page's ink. */
  cut: { borderRadius: 10, overflow: "hidden" },
  details: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  summary: { flexDirection: "row", alignItems: "center", gap: 8 },
  flip: { transform: [{ rotate: "180deg" }] },
});
