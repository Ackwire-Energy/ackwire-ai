import { memo, useEffect, useMemo, useState } from "react";
import { Text as RNText, StyleSheet, View } from "react-native";
import { Text, useReducedMotion } from "@/ui";
import { useColors } from "../shared/hooks";
import { MONO } from "../shared/parts";
import { type Inline, parseBlocks } from "./logic";

/**
 * A message's text: paragraphs, lists, quotes, headings, bold, italic,
 * @mentions and code (mono only for code). While an agent writes, its
 * blue caret blinks at the end.
 */
export const MessageText = memo(function MessageText({
  body,
  streaming = false,
  muted = false,
  selectable = true,
}: {
  body: string;
  streaming?: boolean;
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
  const caret = streaming ? <Caret /> : null;
  return (
    <View style={styles.wrap}>
      {blocks.map((b, i) => {
        const end = i === last ? caret : null;
        switch (b.kind) {
          case "code":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={[styles.code, { backgroundColor: c.sunken }]}>
                <RNText selectable={selectable} style={[styles.mono, { color: c.ink2 }]}>
                  {b.text}
                </RNText>
                {end}
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

/** The agent's caret while it writes (agent blue: the agent's identity); still with reduce motion. */
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
  return <RNText style={{ color: c.agent, opacity: on ? 1 : 0 }}>{" ▍"}</RNText>;
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginTop: 1 },
  /** Readable turns (MobileIntencional.html): 17 with a line-height of ~1.42. */
  line: { lineHeight: 24 },
  flex: { flex: 1 },
  heading: { fontWeight: "700" },
  bullet: { flexDirection: "row", gap: 8, paddingLeft: 2 },
  mark: { minWidth: 14 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  code: { borderRadius: 10, padding: 10 },
  mono: { fontFamily: MONO, fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  inlineCode: { fontFamily: MONO, fontSize: 15 },
});
