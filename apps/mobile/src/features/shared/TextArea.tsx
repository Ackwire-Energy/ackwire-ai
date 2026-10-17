import { StyleSheet, TextInput, type TextInputProps } from "react-native";
import { fonts } from "@/ui";
import { useColors } from "./hooks";

/**
 * A multi-line field on a raised surface (sheets: reason to refuse, a new
 * agent, a task, a mission's goal). The design system has the composer and
 * the search field but no plain text area, so it is composed here.
 */
export function TextArea({ style, minHeight = 84, ...props }: TextInputProps & { minHeight?: number }) {
  const c = useColors();
  return (
    <TextInput
      multiline
      textAlignVertical="top"
      placeholderTextColor={c.faint}
      {...props}
      style={[styles.field, { minHeight, backgroundColor: c.raised, color: c.ink, borderColor: c.line }, style]}
    />
  );
}

const styles = StyleSheet.create({
  field: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 16,
    lineHeight: 22,
    fontFamily: fonts.sans,
  },
});
