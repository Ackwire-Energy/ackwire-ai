import { ROLE_MAX } from "@agenteschat/client/lib/new-agent";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { CharCount, fieldText, Text } from "@/ui";
import { useColors } from "../shared/hooks";

/**
 * An agent's role as Criar agente and Editar ask it: one or two words, counted to `ROLE_MAX` beside its label. A longer
 * one saved before shows past the count, and typing stops at it.
 */
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
      <View style={styles.head}>
        <Text variant="footnote" tone="faint">
          {t("agent.roleLabel")}
        </Text>
        <CharCount
          count={value.length}
          max={ROLE_MAX}
          label={t("newAgent.roleCount", { count: value.length, max: ROLE_MAX })}
        />
      </View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        maxLength={ROLE_MAX}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        accessibilityLabel={t("agent.roleLabel")}
        style={[styles.input, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: 10 },
  input: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
});
