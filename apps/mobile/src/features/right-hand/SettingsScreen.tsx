import { type Agent, useModelLabel, useRoles, useUpdateAgent } from "@agenteschat/client";
import { audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { AUTO } from "@agenteschat/client/lib/providers";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, fieldText, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { openAgentEdit } from "../agents/AgentEditScreen";
import { openAgentAi } from "../ai/AgentAiScreen";
import { useFailed } from "../routines/hooks";
import { Gap, SettingsPage } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";

/** Opens Configurações › the right hand (ADR 0134). */
export const openRightHandSettings = () => router.push("/settings/right-hand" as never);

/**
 * Configurações › Lodi (ADR 0134), as on the web: only what admins set for the team's right hand. Its name and look,
 * its AI and model, its own monthly budget and who may use it (everyone, or the roles picked); one line says it can't
 * be archived or deleted, and its audit log is a tap away. Its instructions are the product's.
 */
export function RightHandSettingsScreen() {
  const { t } = useTranslation();
  const agent = rightHandOf(useDirectory().agents);
  if (!agent)
    return (
      <SettingsPage title={t("settings.section.right_hand")}>
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </SettingsPage>
    );
  return <Form agent={agent} />;
}

function Form({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const toast = useToast();
  const failed = useFailed();
  const modelLabel = useModelLabel();
  const roles = useRoles(orgId).data?.roles ?? [];
  const update = useUpdateAgent(orgId, agent.id);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const g = agentGrammar(agent.name);
  const audience = audienceOf(agent);
  const picked = audience.mode === "people" ? audience.roleIds : [];
  const save = (patch: Parameters<typeof update.mutate>[0]) => update.mutate(patch, { onError: failed });
  const saveBudget = () => {
    const typed = budget.trim().replace(",", ".");
    const amount = typed === "" ? null : Number(typed);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      toast({ title: t("agent.budgetInvalid"), icon: "x" });
      return;
    }
    if (amount !== (agent.monthlyBudgetUsd ?? null)) save({ monthlyBudgetUsd: amount });
  };
  // No role left picked: everyone again.
  const toggleRole = (id: string) => {
    const roleIds = picked.includes(id) ? picked.filter((r) => r !== id) : [...picked, id];
    save({
      audience: audiencePatch(
        roleIds.length ? { ...audience, mode: "people", userIds: [], roleIds } : { ...audience, mode: "everyone" },
      ),
    });
  };
  return (
    <SettingsPage title={agent.name} subtitle={t("rightHand.label")}>
      <GroupedHeader>{t("rightHand.settings.name")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          leading={<AgentFace agentId={agent.id} size={36} live={false} />}
          label={agent.name}
          sub={`@${agent.handle}`}
          value={t("rightHand.settings.changeLook")}
          chevron
          onPress={() => openAgentEdit(agent.id)}
        />
      </GroupedList>
      <GroupedFooter>{t("rightHand.settings.nameHelp", { ...g, label: t("rightHand.label") })}</GroupedFooter>

      <GroupedHeader>{t("rightHand.settings.ai")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="brain"
          label={agent.model === AUTO ? t("brain.auto.label") : (modelLabel(agent.model) ?? agent.model)}
          chevron
          onPress={() => openAgentAi(agent.id)}
        />
      </GroupedList>
      <GroupedFooter>{t("rightHand.settings.aiHelp")}</GroupedFooter>

      <GroupedHeader>{t("rightHand.settings.budget")}</GroupedHeader>
      <View style={[styles.budget, { backgroundColor: c.raised }]}>
        <Text variant="body" tone="muted">
          US$
        </Text>
        <TextInput
          value={budget}
          onChangeText={setBudget}
          onEndEditing={saveBudget}
          keyboardType="decimal-pad"
          placeholder={t("rightHand.value.budgetDefault")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("rightHand.settings.budget")}
          style={[styles.amount, fieldText("body"), { color: c.ink }]}
        />
        <Text variant="body" tone="muted">
          {t("rightHand.settings.perMonth")}
        </Text>
      </View>
      <GroupedFooter>{t("rightHand.settings.budgetHelp", g)}</GroupedFooter>

      <GroupedHeader>{t("rightHand.settings.audience")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="members"
          label={t("audience.mode.everyone")}
          checked={picked.length === 0}
          onPress={() => picked.length > 0 && save({ audience: audiencePatch({ ...audience, mode: "everyone" }) })}
        />
        {roles.map((r) => (
          <GroupedRow key={r.id} label={r.name} checked={picked.includes(r.id)} onPress={() => toggleRole(r.id)} />
        ))}
      </GroupedList>
      <GroupedFooter>{`${t("rightHand.settings.audienceHelp", g)} ${t("audience.rolesHint")}`}</GroupedFooter>

      <Gap />
      <GroupedList>
        <GroupedRow
          icon="list"
          label={t("rightHand.settings.audit", g)}
          chevron
          onPress={() => router.push({ pathname: "/settings/audit", params: { agent: agent.id } } as never)}
        />
      </GroupedList>
      <GroupedFooter>{t("rightHand.settings.lock", g)}</GroupedFooter>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  budget: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 14,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  amount: { flex: 1, paddingVertical: 12 },
});
