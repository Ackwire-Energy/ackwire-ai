import { StyleSheet, TextInput, View } from "react-native";
import { fieldText, Text } from "@/ui";
import { useColors } from "../shared/hooks";

/** An agent's @ field (a new agent's, Editar's Menções): the @ drawn before what is typed. */
export function HandleInput({
  value,
  onChangeText,
  label,
  placeholder,
}: {
  value: string;
  onChangeText: (value: string) => void;
  label: string;
  placeholder?: string;
}) {
  const c = useColors();
  return (
    <View style={[styles.affix, { backgroundColor: c.raised, borderColor: c.line }]}>
      <Text variant="body" tone="faint">
        @
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        maxLength={32}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        accessibilityLabel={label}
        style={[styles.affixInput, fieldText("body"), { color: c.ink }]}
      />
    </View>
  );
}

/** What keeps a field from going through, in the danger color, read out when it shows. */
export function ErrorLine({ text }: { text: string }) {
  const c = useColors();
  return (
    <Text variant="footnote" style={{ color: c.danger }} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  affix: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
  },
  affixInput: { flex: 1, paddingVertical: 12 },
});
