import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput } from "react-native";
import { fieldText, Text } from "@/ui";
import { useColors } from "../shared/hooks";

/** An agent's role as Criar agente and Editar ask it, up to the API's 200 characters. */
export function RoleInput({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <>
      <Text variant="footnote" tone="faint" style={styles.label}>
        {t("agent.roleLabel")}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        maxLength={200}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        accessibilityLabel={t("agent.roleLabel")}
        style={[styles.input, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: 10 },
  input: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
});
