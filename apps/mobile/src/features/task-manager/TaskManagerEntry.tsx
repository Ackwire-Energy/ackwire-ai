import { agentSummary, taskState } from "@agenteschat/client/lib/task-manager";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Count, Icon, PixelOrbit, Text, weights } from "@/ui";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile } from "../shared/parts";
import { useTasksToday } from "./hooks";
import { groupLine } from "./logic";

/** While Agentes is on screen its row asks again this often (the manager itself asks every few seconds). */
const ENTRY_POLL_MS = 15_000;

/**
 * Agentes' way into the task manager (ADR 0128): its name, how the tasks stand ("3 trabalhando · 1 espera você") and
 * how many there are. A server without the task manager shows no row.
 */
export function TaskManagerEntry() {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const tasks = useTasksToday({ pollMs: ENTRY_POLL_MS });
  if (tasks.isError && !tasks.data) return null;
  const list = tasks.data?.tasks ?? [];
  const sum = agentSummary(list);
  const lead = list.find((x) => taskState(x) === "working");
  const hidden = tasks.data?.hidden;
  const line = !tasks.data
    ? null
    : sum.tasks === 0 && !hidden?.total
      ? t("taskManager.empty.title")
      : groupLine(t, { ...sum, working: sum.working + (hidden?.working ?? 0) }).text;
  return (
    <Pressable
      onPress={() => router.push("/task-manager")}
      accessibilityRole="button"
      accessibilityLabel={[t("taskManager.title"), line].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <Tile icon="list" size={36} />
      <View style={styles.text}>
        <Text variant="callout" numberOfLines={1} style={styles.bold}>
          {t("taskManager.title")}
        </Text>
        {line ? (
          <View style={styles.line}>
            {lead ? (
              <PixelOrbit color={agentLook(dir.anyAgent(lead.agentId)).color} size={11} />
            ) : sum.waiting > 0 ? (
              <Icon name="wait" size={12} color={c.amber} />
            ) : null}
            <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
              {line}
            </Text>
          </View>
        ) : null}
      </View>
      {sum.tasks > 0 ? <Count value={sum.tasks} size={15} weight={weights.medium} color={c.faint} /> : null}
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingLeft: 22, paddingRight: 16 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  bold: { fontWeight: "600" },
  shrink: { flexShrink: 1 },
});
