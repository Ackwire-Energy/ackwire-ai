import { EmptyState, TabPanel, Tabs } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApprovals, useChannels } from "@/api/queries";
import type { Approval } from "@/api/types";
import { ApprovalListItem } from "@/components/ApprovalItem";
import {
  MissionCommandsPending,
  MissionsWaitingList,
  pendingCommandCount,
  useMissionsWaitingYou,
} from "@/components/missions/MissionWaiting";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/** Pending first (oldest request first, it expires sooner); decided newest first. */
export function splitApprovals(list: Approval[]) {
  const pending = list.filter((a) => a.status === "pending").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const decided = list
    .filter((a) => a.status !== "pending")
    .sort((a, b) => ((a.decidedAt ?? a.createdAt) < (b.decidedAt ?? b.createdAt) ? 1 : -1));
  return { pending, decided };
}

/** telas/Aprovacoes.dc.html; plus the missions' command cards and what waits on you in them (ADR 0029). */
export function ApprovalsPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const channels = useChannels(org.id);
  const dir = useDirectory(org.id);
  const [tab, setTab] = useState<"pending" | "done">("pending");
  const { pending, decided } = splitApprovals(approvals.data ?? []);
  const visible = tab === "pending" ? pending : decided;
  // Missions: the executor's commands and what waits on you (decisions, reviews) in missions you own or decide.
  const { missions } = useMissionsWaitingYou();
  const commands = pendingCommandCount(missions);
  const missionWaiting = missions.some((m) => m.pending.decisions + m.pending.provisional + m.pending.reviews > 0);

  return (
    <div className="page page--mid">
      <header className="page__header">
        <h1 className="page-title">{t("approvals.title")}</h1>
        <p className="page-sub">{t("approvals.subtitle")}</p>
      </header>
      <Tabs
        value={tab}
        onValueChange={setTab}
        label={t("approvals.filter")}
        items={[
          { value: "pending", label: t("approvals.pending"), count: pending.length + commands },
          { value: "done", label: t("approvals.decided"), count: decided.length },
        ]}
      >
        <TabPanel value={tab}>
          {approvals.isSuccess && visible.length === 0 && (tab === "done" || (commands === 0 && !missionWaiting)) && (
            <EmptyState>{tab === "pending" ? t("approvals.emptyPending") : t("approvals.emptyDecided")}</EmptyState>
          )}
          {visible.map((a) => (
            <ApprovalListItem
              key={a.id}
              approval={a}
              agent={dir.agentById.get(a.agentId)}
              channel={channels.data?.find((c) => c.id === a.channelId)}
              members={dir.memberById}
              initials={dir.agentInitials(a.agentId)}
            />
          ))}
          {tab === "pending" && (
            <>
              <MissionCommandsPending missions={missions} />
              <MissionsWaitingList missions={missions} />
            </>
          )}
        </TabPanel>
      </Tabs>
      <p className="page__note">{t("approvals.footer")}</p>
    </div>
  );
}
