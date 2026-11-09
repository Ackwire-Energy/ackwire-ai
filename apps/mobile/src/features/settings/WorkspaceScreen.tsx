import {
  useAgents,
  useAiAccounts,
  useAiStatus,
  useComputerSetup,
  useConnections,
  useCredentials,
  useInvitations,
  useMachines,
  useOverview,
  usePlatformKey,
  useSkills,
  useStorage,
} from "@agenteschat/client";
import { computerEdition } from "@agenteschat/client/lib/computer";
import { capitalize } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { workspaceUsesApi } from "@agenteschat/client/lib/plan-usage";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, haptics } from "@/ui";
import { router } from "@/ui/navigation";
import { AgentFace } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { OrgAvatar } from "../shared/OrgAvatar";
import { areaValues, SETTINGS_GROUPS, type SettingsEntry, type SettingsSection, visibleSections } from "./logic";
import { Gap, SettingsPage } from "./parts";

/** The rows whose group already says the rest get a shorter name (`mobile.settings.section.*`). */
const SHORT: Partial<Record<SettingsSection, string>> = {
  members: "mobile.settings.section.members",
  roles: "mobile.settings.section.roles",
  access: "mobile.settings.section.access",
  connectors: "mobile.settings.section.connectors",
  usage: "mobile.settings.section.usage",
};

/**
 * The workspace's settings, a screen pushed from Você on the grouped gray, as the phone's own settings: four groups,
 * each thing once. Workspace: the workspace itself (its mark, its name, what Geral holds), its right hand by its
 * face and name, GIFs. Pessoas, Agentes, Custos e dados: one neutral tile and one short value per row (a count or
 * a state), the area's own screen says the rest. Owners get "Apagar <nome>" alone in red at the end, behind the
 * system's alert (one firm haptic as it confirms), then the proof and the hold. Opened often, so nothing animates
 * here beyond the rows' press highlight and the platform's push.
 */
export function WorkspaceScreen() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const areas = visibleSections(org);
  const values = useAreaValues(areas);
  // The right hand's row goes by its name and face (admins may rename it).
  const rightHand = rightHandOf(useDirectory().agents);
  const name = org?.name ?? "";
  const confirmDelete = () =>
    Alert.alert(t("deleteOrg.title", { name }), t("mobile.settings.deleteAlert"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("mobile.settings.deleteAction"),
        style: "destructive",
        onPress: () => {
          // One firm tap as the destructive step is taken, in the same moment the next screen comes.
          haptics.medium();
          router.push("/settings/delete");
        },
      },
    ]);
  return (
    <SettingsPage title={t("settings.title")}>
      {SETTINGS_GROUPS.map((group) => {
        const rows = areas.filter((s) => s.group === group);
        if (rows.length === 0) return null;
        return (
          <Fragment key={group}>
            <GroupedHeader>{t(`mobile.settings.group.${group}`)}</GroupedHeader>
            <GroupedList>
              {rows.map((s) =>
                s.id === "general" ? (
                  <GroupedRow
                    key={s.id}
                    leading={<OrgAvatar logo={org?.logo} size={36} />}
                    label={name}
                    sub={t("mobile.settings.editSub")}
                    chevron
                    onPress={() => router.push(s.href as never)}
                  />
                ) : s.id === "right_hand" && rightHand ? (
                  <GroupedRow
                    key={s.id}
                    leading={<AgentFace agentId={rightHand.id} size={36} live={false} />}
                    label={rightHand.name}
                    // Its one role name, never its stored role ("Workspace assistant", in no person's language).
                    sub={capitalize(t("rightHand.label"), i18n.language)}
                    chevron
                    onPress={() => router.push(s.href as never)}
                  />
                ) : (
                  <GroupedRow
                    key={s.id}
                    icon={s.icon}
                    label={t(SHORT[s.id] ?? `settings.section.${s.id}`)}
                    {...(values[s.id] ? { value: values[s.id] } : {})}
                    chevron
                    onPress={() => router.push(s.href as never)}
                  />
                ),
              )}
            </GroupedList>
          </Fragment>
        );
      })}
      {org?.role === "owner" ? (
        <>
          <Gap />
          <Gap />
          <GroupedList>
            <GroupedRow label={t("mobile.settings.deleteName", { name })} danger onPress={confirmDelete} />
          </GroupedList>
          <GroupedFooter>{t("mobile.settings.deleteFoot")}</GroupedFooter>
        </>
      ) : null}
    </SettingsPage>
  );
}

/** Each area's value, as the web's tiles count (`areaValues`): asked only for the areas shown. */
function useAreaValues(areas: readonly SettingsEntry[]) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const shown = (id: string) => areas.some((s) => s.id === id);
  const overview = useOverview(orgId);
  const invitations = useInvitations(orgId, can(org, "invite_people"));
  const connections = useConnections(orgId);
  const skills = useSkills(orgId, shown("skills"));
  const machines = useMachines(orgId, shown("computers"));
  const managesKeys = can(org, "manage_credentials");
  const credentials = useCredentials(orgId, managesKeys);
  const plans = useAiAccounts(orgId, shown("keys") && !managesKeys);
  const platform = usePlatformKey(orgId);
  const storage = useStorage(orgId, shown("storage"));
  const edition = computerEdition(useComputerSetup(orgId, shown("storage")).data);
  const agents = useAgents(orgId).data ?? [];
  const aiStatus = useAiStatus(orgId).data;
  return areaValues(t, i18n.language, {
    overview: overview.data,
    usesApi: overview.data && workspaceUsesApi(agents, aiStatus, overview.data.budgetUsedPercent),
    invitations: invitations.data?.length,
    connectors: connections.data?.filter((x) => !x.revokedAt).map((x) => x.label),
    skills: skills.data?.length,
    computers: machines.data
      ? { count: machines.data.length, online: machines.data.filter((m) => m.online).length }
      : undefined,
    keys: managesKeys
      ? credentials.data
        ? {
            manages: true,
            live: credentials.data.filter((k) => !k.revokedAt).length,
            platform: Boolean(platform.data),
          }
        : undefined
      : plans.data
        ? { manages: false, plans: plans.data.accounts.length }
        : undefined,
    storage: storage.data && edition ? { kind: storage.data.kind, edition } : undefined,
  });
}
