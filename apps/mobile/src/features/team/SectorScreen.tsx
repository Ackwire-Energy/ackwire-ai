import { useAgentGroupAction, useAgentGroups, useMembers } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, haptics, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { plainRole } from "../agents/logic";
import { chooseAction, SettingsPage } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { goBack } from "../shared/parts";

/**
 * One setor (ADR 0148), from Equipe's list: who cares for it and who stands in (a tap picks another person, in place,
 * for who manages agents), its agents (each opens its profile), and, last, deleting it as a red row the system's alert
 * confirms, saying its agents go back to Agentes. Its look and its channels stay on the web.
 */
export function SectorScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const groups = useAgentGroups(orgId);
  const members = useMembers(orgId);
  const action = useAgentGroupAction(orgId);
  const group = groups.data?.find((g) => g.id === id);
  const manages = can(org, "manage_agents");
  if (!group) {
    return (
      <SettingsPage title={t("agentGroups.group")}>
        {groups.isLoading ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : (
          <EmptyState size="panel" icon="members" title={t("common.loadFailed")} />
        )}
      </SettingsPage>
    );
  }
  const people = (members.data ?? []).filter((m) => m.userId);
  const nameOf = (userId: string | null | undefined) =>
    userId ? dir.nameOf({ type: "person", id: userId }) || t("channel.unknownPerson") : t("team.sectors.nobody");
  const failed = (e: unknown) => toast({ title: errorText(t, e), icon: "x" });
  // A person for the lead or the stand-in, in place (the system's list), "Ninguém" first to clear it.
  const pick = (title: string, set: (userId: string | null) => void) =>
    chooseAction(
      title,
      [
        { label: t("team.sectors.nobody"), onPress: () => set(null) },
        ...people.map((m) => ({ label: m.name, onPress: () => set(m.userId) })),
      ],
      t("common.cancel"),
    );
  const setPerson = (field: "leadUserId" | "backupUserId") => (userId: string | null) => {
    haptics.selection();
    action.mutate({ type: "update", groupId: group.id, [field]: userId }, { onError: failed });
  };
  const remove = () =>
    Alert.alert(t("agentGroups.deleteTitle", { name: group.name }), t("agentGroups.deleteText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("agentGroups.delete"),
        style: "destructive",
        onPress: () =>
          action.mutate(
            { type: "remove", groupId: group.id },
            {
              onSuccess: () => {
                haptics.medium();
                goBack();
              },
              onError: failed,
            },
          ),
      },
    ]);
  const agents = group.agentIds.flatMap((agentId) => {
    const a = dir.agentById.get(agentId);
    return a ? [a] : [];
  });
  return (
    <SettingsPage title={group.name} subtitle={t("team.agents", { count: agents.length })} locked={action.isPending}>
      <GroupedHeader>{t("agentGroups.group")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="person"
          label={t("team.sectors.leadLabel")}
          value={nameOf(group.leadUserId)}
          {...(manages
            ? { menu: true, onPress: () => pick(t("team.sectors.leadLabel"), setPerson("leadUserId")) }
            : {})}
        />
        <GroupedRow
          icon="members"
          label={t("team.sectors.backupLabel")}
          value={nameOf(group.backupUserId)}
          {...(manages
            ? { menu: true, onPress: () => pick(t("team.sectors.backupLabel"), setPerson("backupUserId")) }
            : {})}
        />
      </GroupedList>
      {!group.leadUserId ? <GroupedFooter>{t("team.sectors.gap.noLead")}</GroupedFooter> : null}
      <GroupedHeader>{t("mobile.agents.title")}</GroupedHeader>
      <GroupedList>
        {agents.map((a) => {
          // What it does in plain words, else its role; nothing under the name when it has neither.
          const does = plainRole(a.instructions) ?? a.role.trim();
          return (
            <GroupedRow
              key={a.id}
              leading={<AgentFace agentId={a.id} size={36} live={false} />}
              label={a.name}
              {...(does ? { sub: does } : {})}
              chevron
              onPress={() => router.push(`/agent/${a.id}`)}
            />
          );
        })}
        {agents.length === 0 ? <GroupedRow label={t("team.sectors.none")} faint /> : null}
      </GroupedList>
      {manages ? (
        <View style={styles.apart}>
          <GroupedList>
            <GroupedRow label={t("agentGroups.delete")} danger onPress={remove} />
          </GroupedList>
        </View>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 32 },
  apart: { marginTop: 24 },
});
