import type { DiffLine } from "@agenteschat/ui/diff";
import { Text as RNText, StyleSheet, View } from "react-native";
import { fonts, useTheme } from "./theme";

/**
 * A line diff drawn as the web's: added lines bold on a soft band, removed ones struck through. `prose`: words, not
 * code, so no mono (a proposed change to a text).
 */
export function DiffView({ lines, prose = false }: { lines: DiffLine[]; prose?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.diff, { backgroundColor: colors.sunken, borderColor: colors.line }]}>
      {lines.map((l, i) => (
        <RNText
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          key={i}
          style={[
            prose ? styles.prose : styles.line,
            { color: l.kind === "del" ? colors.faint : colors.ink2 },
            l.kind === "add" && styles.added,
            l.kind === "del" && styles.removed,
          ]}
        >
          {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
          {l.text || " "}
        </RNText>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  diff: { borderRadius: 14, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  line: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
  prose: { fontSize: 13, lineHeight: 19 },
  added: { fontWeight: "600" },
  removed: { textDecorationLine: "line-through" },
});
