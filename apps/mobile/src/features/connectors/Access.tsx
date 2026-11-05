import { keys, useAgentAccess, useApi, useCustomServerAction, useDisconnect } from "@agenteschat/client";
import {
  LEVELS,
  type Level,
  type LevelState,
  levelIn,
  levelOf,
  resourcesOf,
  saveLevels,
  sharedLevel,
} from "@agenteschat/client/lib/access-levels";
import type { ConnectedItem } from "@agenteschat/client/lib/connected";
import { can } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Icon, useToast } from "@/ui";
import { useAgentsAccess, useSetLevels } from "../settings/hooks";
import { chooseAction, confirmAction } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { errorHaptic, successHaptic, Tile } from "../shared/parts";

/**
 * Who uses a connection and how far, as the phone's settings list it: "Todos os agentes" first (admins: it sets every
 * agent), then one row per agent, the level as the row's value ("Sem acesso", "Ler", "Ler e escrever", the web's
 * words); a tap opens the system's choice. Who may not change it sees the value alone. What always asks is the
 * footer, in one sentence.
 */
export function AgentLevelList({ connectionId, title }: { connectionId: string; title?: string }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const qc = useQueryClient();
  const orgId = useOrgId();
  const { org } = useOrg();
  // A new connection: every agent's tree must be read again to show it.
  useEffect(() => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[2] === "access" });
  }, [qc]);
  const everyone = dir.agents.length > 1 && can(org, "manage_agents");
  // One block: a sheet's gap goes around it, never between the header and its rows.
  return (
    <View>
      <GroupedHeader>{title ?? t("mobile.connectors.whoTitle")}</GroupedHeader>
      <GroupedList>
        {everyone ? (
          <EveryoneRow key="everyone" connectionId={connectionId} leading={<Tile icon="members" size={30} />} />
        ) : null}
        {dir.agents.map((a) => (
          <AgentLevelRow
            key={a.id}
            orgId={orgId}
            agentId={a.id}
            connectionId={connectionId}
            leading={<AgentFace agentId={a.id} size={30} live={false} />}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("mobile.connectors.safe")}</GroupedFooter>
    </View>
  );
}

/** A level in the web's words ("Personalizado" when the agent's tools were set one by one). */
const useLevelWord = () => {
  const { t } = useTranslation();
  return (level: LevelState) => t(`access.level.${level}`);
};

/** The system's choice of a level (an action sheet on iOS, a dialog on Android). */
function pickLevel(title: string, cancel: string, word: (l: LevelState) => string, choose: (l: Level) => void) {
  chooseAction(
    title,
    LEVELS.map((l) => ({ label: word(l), onPress: () => choose(l) })),
    cancel,
  );
}

/** "Todos os agentes": picking a level saves it for every agent, one by one. */
function EveryoneRow({ connectionId, leading }: { connectionId: string; leading: ReactNode }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const toast = useToast();
  const word = useLevelWord();
  const access = useAgentsAccess(dir.agents);
  const set = useSetLevels();
  const [saving, setSaving] = useState<Level | null>(null);
  const resourceId = `connector:${connectionId}`;
  const levels = dir.agents.map((a) => levelIn(access.byAgent.get(a.id), resourceId));
  const current = saving ?? (access.loading ? null : sharedLevel(levels));
  const choose = async (level: Level) => {
    if (saving || access.loading || level === current) return;
    setSaving(level);
    try {
      for (const [i, a] of dir.agents.entries()) {
        if (levels[i] !== level) await set.mutateAsync({ agentId: a.id, changes: { [resourceId]: level } });
      }
      successHaptic();
    } catch {
      errorHaptic();
      toast({ title: t("mobile.connectors.everyoneFailed"), icon: "x" });
    } finally {
      setSaving(null);
    }
  };
  return (
    <GroupedRow
      leading={leading}
      label={t("connectFlow.everyone")}
      sub={t("connectFlow.everyoneCount", { count: dir.agents.length })}
      {...(current ? { value: word(current) } : {})}
      chevron
      disabled={Boolean(saving) || access.loading}
      onPress={() => pickLevel(t("connectFlow.everyone"), t("common.cancel"), word, (l) => void choose(l))}
    />
  );
}

function AgentLevelRow({
  orgId,
  agentId,
  connectionId,
  leading,
}: {
  orgId: string;
  agentId: string;
  connectionId: string;
  leading: ReactNode;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const toast = useToast();
  const word = useLevelWord();
  const { org } = useOrg();
  const agent = dir.agentById.get(agentId);
  const access = useAgentAccess(orgId, agentId);
  const [saving, setSaving] = useState<Level | null>(null);
  const resource = access.data ? resourcesOf(access.data).find((r) => r.id === `connector:${connectionId}`) : undefined;
  const current: LevelState = saving ?? (resource ? levelOf(resource) : "none");
  // Giving an agent a connector is an admin's call, like its scopes (the server checks it again).
  const mayChange = can(org, "manage_agents") && Boolean(resource);
  const choose = (level: Level) => {
    if (!resource || level === current) return;
    setSaving(level);
    void saveLevels(api, orgId, agentId, { [resource.id]: level })
      .then((next) => {
        successHaptic();
        qc.setQueryData(keys.agentAccess(orgId, agentId), next);
      })
      .catch(() => {
        errorHaptic();
        toast({ title: t("mobile.connectors.levelFailed", { name: agent?.name ?? "" }), icon: "x" });
      })
      .finally(() => setSaving(null));
  };
  const open = () => pickLevel(agent?.name ?? "", t("common.cancel"), word, choose);
  return (
    <GroupedRow
      leading={leading}
      label={agent?.name ?? ""}
      {...(agent?.role ? { sub: agent.role } : {})}
      value={word(current)}
      chevron={mayChange}
      disabled={Boolean(saving)}
      {...(mayChange ? { onPress: open } : {})}
    />
  );
}

/**
 * Disconnecting, alone in its group at the page's end in red, after the system's confirmation saying how many agents
 * lose it (the web's dialog).
 */
export function DisconnectRow({ item, name, onDone }: { item: ConnectedItem; name: string; onDone: () => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const dir = useDirectory();
  const access = useAgentsAccess(dir.agents);
  const disconnect = useDisconnect(orgId);
  const { disconnect: disconnectServer } = useCustomServerAction(orgId);
  const users = dir.agents.filter((a) => levelIn(access.byAgent.get(a.id), `connector:${item.id}`) !== "none").length;
  const run = () => {
    const done = {
      onSuccess: () => {
        successHaptic();
        onDone();
        toast({ title: t("mobile.connectors.disconnected", { name }) });
      },
      onError: () => {
        errorHaptic();
        toast({ title: t("mobile.connectors.disconnectFailed", { name }), icon: "x" });
      },
    };
    // A server connected by address is removed through its own endpoint (as on the web).
    if (item.custom) disconnectServer.mutate(item.id, done);
    else disconnect.mutate(item.id, done);
  };
  return (
    <GroupedList>
      <GroupedRow
        label={t("mobile.connectors.disconnect")}
        danger
        disabled={disconnect.isPending || disconnectServer.isPending}
        onPress={() =>
          confirmAction({
            title: t("connectors.disconnectTitle", { name }),
            text: users > 0 ? t("connectors.disconnectText", { count: users }) : t("connectors.disconnectTextNone"),
            action: t("mobile.connectors.disconnect"),
            cancel: t("common.cancel"),
            onConfirm: run,
          })
        }
      />
    </GroupedList>
  );
}

/** A row's leading tile with the amber wait mark: something here waits on the person (tools to decide). */
export function WaitTile() {
  const c = useColors();
  return (
    <View style={[styles.tile, { backgroundColor: c.sunken }]}>
      <Icon name="wait" size={16} color={c.amber} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
