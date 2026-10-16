import { Button, EmptyState, Icon, Menu, MenuItem } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMissionList } from "@/api/missions";
import { useChannels } from "@/api/queries";
import type { Mission } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { formatShortDate, relativeTime } from "@/lib/format";
import { isOpenMission, missionCells, missionCellTitles, waitingText } from "@/lib/missions";
import { MachineChip, MissionStatusChip, MissionStrip } from "./MissionBits";
import { CloseMissionDialog } from "./MissionDialogs";

/**
 * The Missões tab (Threads.html): one card per mission with its agent, the
 * home thread, the plan as the pixel strip ("4 de 12 itens"), what waits for
 * you, what runs on the computer (online or offline), when it started, and
 * Abrir thread. Active first, then the ones that ended.
 */
export function MissionsTab({
  filters,
  onNew,
}: {
  filters: { q: string; agentId?: string; channelId?: string };
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const q = filters.q.trim();
  // The server filters (conversation, agent, words) and counts with the same filters.
  const where = {
    ...(q ? { q } : {}),
    ...(filters.agentId ? { agentId: filters.agentId } : {}),
    ...(filters.channelId ? { channelId: filters.channelId } : {}),
  };
  const open = useMissionList(org.id, { status: "open", ...where });
  const closed = useMissionList(org.id, { status: "closed", ...where });
  const active: Mission[] = open.data?.missions ?? [];
  const ended: Mission[] = closed.data?.missions ?? [];
  const counts = open.data?.counts ?? closed.data?.counts;
  if (open.isPending) return <LoadingList count={3} />;
  if (open.isError && !open.data) return <ErrorState error={open.error} onRetry={() => void open.refetch()} />;
  if (active.length === 0 && ended.length === 0) {
    const filtered = Boolean(q || filters.agentId || filters.channelId);
    return (
      <EmptyState
        sky={!filtered}
        icon={filtered ? "search" : "flag"}
        title={filtered ? t("threads.empty.noResults") : t("missions.empty.title")}
        actions={
          filtered ? undefined : (
            <Button size="sm" variant="primary" icon="plus" onClick={onNew}>
              {t("missions.new.open")}
            </Button>
          )
        }
      >
        {filtered ? t("threads.empty.noResultsText") : t("missions.empty.text")}
      </EmptyState>
    );
  }
  return (
    <div className="mi-tab">
      {active.length > 0 && (
        <section>
          <h2 className="mi-section-title">
            {t("missions.list.active")} · {counts?.active ?? active.length}
            {(counts?.waitingYou ?? 0) > 0 && (
              <span className="mi-section-title__aside">
                {" "}
                · {t("missions.list.waitingYouCount", { count: counts?.waitingYou ?? 0 })}
              </span>
            )}
          </h2>
          <div className="mi-mcs">
            {active.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </div>
        </section>
      )}
      {ended.length > 0 && (
        <section>
          <h2 className="mi-section-title">
            {t("missions.list.ended")} · {counts?.closed ?? ended.length}
          </h2>
          <div className="mi-mcs">
            {ended.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MissionCard({ mission: m }: { mission: Mission }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const channels = useChannels(org.id);
  const [closing, setClosing] = useState(false);
  const agent = dir.agentById.get(m.agentId);
  const channel = channels.data?.find((c) => c.id === m.channelId);
  const where = channel ? t("missions.list.threadIn", { channel: channel.name }) : t("missions.list.threadInDm");
  const offline = Boolean(m.machine && !m.machine.online);
  const waiting = waitingText(t, m);
  const open = isOpenMission(m);
  const threadLink = { to: "/org/$orgId/threads/$threadId" as const, params: { orgId: org.id, threadId: m.threadId } };
  const more = t("missions.list.more", { title: m.title });
  return (
    <article className="mi-mc" aria-label={t("missions.list.card", { title: m.title })}>
      <div className="mi-mc__head">
        <AgentAvatar agentId={m.agentId} name={agent?.name ?? ""} size="md" running={m.runningTasks > 0 && !offline} />
        <div className="mi-mc__t">
          <h3>
            <Link {...threadLink}>{m.title}</Link>
          </h3>
          <small>
            <span>{agent?.name ?? t("channel.unknownAgent")}</span>
            <span aria-hidden="true">·</span>
            <Link {...threadLink} className="mi-lnk">
              <Icon name="thread" size={14} />
              {where}
            </Link>
            <span aria-hidden="true">·</span>
            <span>
              {t("missions.list.started", { date: formatShortDate(i18n.language, m.startedAt ?? m.createdAt) })}
            </span>
          </small>
        </div>
        <div className="mi-mc__r">
          <MissionStatusChip mission={m} />
          <Menu
            align="end"
            label={more}
            trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={more} />}
          >
            <MenuItem icon="thread" onSelect={() => void navigate(threadLink)}>
              {t("missions.list.openThread")}
            </MenuItem>
            {open && m.canManage && (
              <MenuItem icon="check" onSelect={() => setClosing(true)}>
                {t("missions.actions.close")}
              </MenuItem>
            )}
          </Menu>
        </div>
      </div>
      <div className="mi-mc__strip">
        <b>
          {m.plan.total > 0
            ? t("missions.items", { done: m.plan.done, count: m.plan.total })
            : t("missions.list.noItems")}
        </b>
        <MissionStrip
          cells={missionCells(m, { offline })}
          titles={missionCellTitles(m)}
          agentId={m.agentId}
          label={t("missions.itemsLabel", { done: m.plan.done, count: m.plan.total })}
        />
      </div>
      {open && (
        <div className="mi-pills mi-mc__pills">
          {waiting && (
            <button type="button" className="mi-pill mi-pill--need" onClick={() => void navigate(threadLink)}>
              <Icon name="waiting" size={14} />
              {t("missions.list.waiting", { what: waiting })}
            </button>
          )}
          {m.runningTasks > 0 && (
            <span className="mi-pill">
              <span className="mi-run">
                <Icon name="spinner" size={14} />
              </span>
              {t("missions.list.running", { count: m.runningTasks })}
            </span>
          )}
          <MachineChip machine={m.machine} />
          {m.status === "paused" && m.pausedAt && (
            <span className="mi-pill">
              <Icon name="clock" size={14} />
              {t("missions.list.pausedSince", { when: relativeTime(t, i18n.language, m.pausedAt) })}
            </span>
          )}
        </div>
      )}
      <div className="mi-mc__foot">
        <Button size="sm" icon="thread" onClick={() => void navigate(threadLink)}>
          {t("missions.list.openThread")}
        </Button>
      </div>
      {closing && <CloseMissionDialog mission={m} open={closing} onOpenChange={setClosing} />}
    </article>
  );
}
