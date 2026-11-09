import { StyleSheet } from "react-native";

/** Narrower than this beside an action, words would be a sliver (about 24 characters of the small text). */
export const ACT_TEXT_MIN = 170;

/**
 * Words and their actions (a mention's reach and "Deixar Ana falar com ela", a change and "Desfazer"), as the web kit's
 * `.ac-actline`: one row that wraps, the words growing from their own one-line width, so the actions sit beside them
 * only while the words fit on one line there, else on a row of their own under them, from the row's start. A close ×
 * is never in it. `row` on the row, `text` on the words; the row keeps its own gap.
 */
export const ACT_LINE = StyleSheet.create({
  row: { flexWrap: "wrap", justifyContent: "flex-start" },
  text: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
});
