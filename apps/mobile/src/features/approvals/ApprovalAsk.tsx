import type { Approval } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, Chip, Fuse, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow } from "../shared/hooks";
import { agentLook, fuseRemaining, minutesLeft } from "../shared/logic";
import { approvalRisk } from "./logic";

/**
 * A request waiting on you, as a block of the "Esperando você" card: who
 * asks, the exact action, the fuse until it expires, Recusar / Ver e aprovar.
 */
export function ApprovalAsk({ approval: a, divider }: { approval: Approval; divider?: boolean }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const now = useNow();
  const c = useColors();
  const agent = dir.agentById.get(a.agentId);
  const high = approvalRisk(a) === "high";
  return (
    <View style={[styles.ask, divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line }]}>
      <View style={styles.hd}>
        <AgentFace agentId={a.agentId} size={22} live={false} />
        <Text variant="small" tone="ink" style={styles.bold}>
          {agent?.name ?? ""}
        </Text>
        <Text variant="small" tone="muted">
          {t("mobile.approval.asks")}
        </Text>
        <View style={styles.grow} />
        {high ? <Chip icon="shield" label={t("mobile.approval.highRisk")} /> : null}
      </View>
      <Text variant="title" style={styles.title}>
        {a.title}
      </Text>
      <View style={styles.fuse}>
        <View style={styles.grow}>
          <Fuse color={agentLook(agent).color} remaining={fuseRemaining(a.createdAt, a.expiresAt, now)} />
        </View>
        <Text variant="caption" tone="faint">
          {t("mobile.approval.expiresIn", { count: minutesLeft(a.expiresAt, now) })}
        </Text>
      </View>
      <View style={styles.acts}>
        <View style={styles.grow}>
          <Button
            variant="secondary"
            size="sm"
            wide
            label={t("mobile.approval.refuse")}
            onPress={() => router.push(`/approval/${a.id}?mode=refuse`)}
          />
        </View>
        <View style={styles.grow}>
          <Button
            variant="primary"
            size="sm"
            wide
            label={t("mobile.approval.review")}
            onPress={() => router.push(`/approval/${a.id}`)}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ask: { paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12 },
  hd: { flexDirection: "row", alignItems: "center", gap: 8 },
  bold: { fontWeight: "600" },
  grow: { flex: 1 },
  title: { marginTop: 7, marginBottom: 10 },
  fuse: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  acts: { flexDirection: "row", gap: 8 },
});
