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
import { can } from "@agenteschat/client/lib/permissions";
import { workspaceUsesApi } from "@agenteschat/client/lib/plan-usage";
import { router } from "expo-router";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { Text } from "@/ui";
import { CoverPage, PageRow, PageSection } from "../shared/CoverPage";
import { OrgAvatar } from "../shared/OrgAvatar";
import { SETTINGS_GROUPS, type SettingsEntry, tileStates, visibleSections } from "./logic";

/**
 * The workspace's settings, as the web's sections in its groups, on a page like Você: the workspace's sky with its
 * mark, its name and who you are there; then "Editar workspace" (its logo, name, zone and what every agent knows)
 * above "Membros e convites", and each area this person opens, with how it is now under its name.
 */
export function WorkspaceScreen() {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const role = org?.role;
  const areas = visibleSections(org).filter((s) => s.id !== "general");
  const states = useAreaStates(areas);
  const overview = useOverview(orgId).data;
  const headline = [
    role ? t(`mobile.me.role.${role}`) : null,
    overview ? t("mobile.chat.people", { count: overview.people }) : null,
    overview ? t("mobile.chat.agentsHere", { count: overview.agents }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <CoverPage face={<OrgAvatar logo={org?.logo} size={68} />} title={org?.name ?? ""} headline={headline}>
      {SETTINGS_GROUPS.map((group) => {
        const rows = areas.filter((s) => s.group === group);
        // The workspace itself heads its own group, above its people.
        const own = group === "org";
        if (rows.length === 0 && !own) return null;
        return (
          <Fragment key={group}>
            <PageSection title={t(`settings.group.${group}`)} />
            {own ? (
              <PageRow
                icon="pen"
                label={can(org, "configure") ? t("mobile.settings.edit") : t("settings.section.general")}
                below={<Line text={t("settings.sectionText.general")} />}
                onPress={() => router.push("/settings/general")}
              />
            ) : null}
            {rows.map((s, i) => (
              <PageRow
                key={s.id}
                icon={s.icon}
                label={t(`settings.section.${s.id}`)}
                below={states[s.id] ? <Line text={states[s.id] ?? ""} /> : undefined}
                divider={own || i > 0}
                onPress={() => router.push(s.href as never)}
              />
            ))}
          </Fragment>
        );
      })}
    </CoverPage>
  );
}

/** The quiet line under an area's name. */
function Line({ text }: { text: string }) {
  return (
    <Text variant="footnote" tone="muted" numberOfLines={1}>
      {text}
    </Text>
  );
}

/** How each area is now, as the web's tiles (`tileStates`): asked only for the areas shown. */
function useAreaStates(areas: readonly SettingsEntry[]) {
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
  return tileStates(t, i18n.language, {
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
