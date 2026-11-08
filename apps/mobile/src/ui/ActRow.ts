import { StyleSheet } from "react-native";

/** Narrower than this beside an action, words would be a sliver (about 24 characters of the small text). */
export const ACT_TEXT_MIN = 170;

/**
 * A row of words and the action that ends it (a mention's reach and "Deixar Ana falar com ela", a change and
 * "Desfazer"), as the web kit's `.ac-actrow`: side by side while the words keep `ACT_TEXT_MIN`, else the action goes
 * under them, at the row's end. The words never wrap a word a line. `row` on the row, `text` on the words.
 */
export const ACT_ROW = StyleSheet.create({
  // The first line is full (the words grow): only an action on a line of its own moves to the end.
  row: { flexWrap: "wrap", justifyContent: "flex-end" },
  text: { flexGrow: 1, flexShrink: 1, flexBasis: ACT_TEXT_MIN, minWidth: 0 },
});
