import { useAgentGroups } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { Tile } from "../shared/parts";

/** Agentes' way into Equipe (ADR 0148): its name and how many setores the team has. */
export function TeamEntry() {
  const { t } = useTranslation();
  const c = useColors();
  const groups = useAgentGroups(useOrgId()).data ?? [];
  const line = groups.length > 0 ? t("team.sectorsCount", { count: groups.length }) : t("mobile.team.entry");
  return (
    <Pressable
      onPress={() => router.push("/team")}
      accessibilityRole="button"
      accessibilityLabel={[t("team.title"), line].join(", ")}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <Tile icon="members" size={36} />
      <View style={styles.text}>
        <Text variant="callout" numberOfLines={1} style={styles.bold}>
          {t("team.title")}
        </Text>
        <Text variant="footnote" tone="muted" numberOfLines={1}>
          {line}
        </Text>
      </View>
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingLeft: 22, paddingRight: 16 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  bold: { fontWeight: "600" },
});
