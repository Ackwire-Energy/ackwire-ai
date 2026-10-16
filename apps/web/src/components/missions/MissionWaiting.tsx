import { Chip, Icon, type IconName } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMissionCommands, useMissionDecisions, useMissionList, useMissionReviews } from "@/api/missions";
import type { Mission, MissionCommand } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { relativeTime } from "@/lib/format";
import { ExecutorChip } from "./MissionBits";
import { MissionCommandCard } from "./MissionCommandCard";
import "./missions.css";

/**
 * Aprovações, for missions (ADR 0029): the executor's pending commands
 * ("Claude Code quer rodar `cmd`", with the mission, its agent, who programs
 * and where, and the same Aprovar / Recusar / Aprovar sempre as in the
 * thread), and "Esperando você em missões": the decisions and reviews that
 * wait on you, each a link to its card in the thread. Only missions you own
 * or decide in (`status=waiting_you`); live through the mission events
 * (`mission.needs_you` reaches you in any channel).
 */
export function useMissionsWaitingYou() {
  const { org } = useOrg();
  const list = useMissionList(org.id, { status: "waiting_you", limit: 50 });
  const missions: Mission[] = (list.data?.missions ?? []).filter((m) => m.canAct);
  return { list, missions };
}

/** How many command cards wait on me across missions (the Pendentes count). */
export const pendingCommandCount = (missions: Mission[]) => missions.reduce((n, m) => n + m.pending.commands, 0);

export function MissionCommandsPending({ missions }: { missions: Mission[] }) {
  const { t } = useTranslation();
  const asking = missions.filter((m) => m.pending.commands > 0);
  if (asking.length === 0) return null;
  return (
    <section className="mi-wait" aria-label={t("approvals.missions.commands")}>
      <h2 className="mi-wait__title">{t("approvals.missions.commands")}</h2>
      {asking.map((m) => (
        <MissionCommands key={m.id} mission={m} />
      ))}
    </section>
  );
}

function MissionCommands({ mission: m }: { mission: Mission }) {
  const { org } = useOrg();
  const commands = useMissionCommands(org.id, m.id);
  const pending: MissionCommand[] = (commands.data?.commands ?? []).filter((c) => c.state === "pending");
  return (
    <>
      {pending.map((c) => (
        <div key={c.id} className="mi-wait__cmd">
          <MissionContext mission={m} />
          <MissionCommandCard
            command={{ id: c.id, missionId: m.id, taskId: c.taskId, tool: c.tool, command: c.command }}
          />
        </div>
      ))}
    </>
  );
}

/** "[agent] App mobile · [mark] Claude Code no mac": whose mission a card belongs to, a link to its thread. */
function MissionContext({ mission: m }: { mission: Mission }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agentName = dir.agentById.get(m.agentId)?.name ?? "";
  return (
    <div className="mi-wait__ctx">
      <AgentAvatar agentId={m.agentId} name={agentName} size="xs" />
      <Link to="/org/$orgId/threads/$threadId" params={{ orgId: org.id, threadId: m.threadId }} className="mi-wait__m">
        {m.title}
      </Link>
      {m.machine && <ExecutorChip mission={m} agentName={agentName} />}
    </div>
  );
}

/** "Esperando você em missões": one row per pending decision or review, linking to its card. */
export function MissionsWaitingList({ missions }: { missions: Mission[] }) {
  const { t } = useTranslation();
  const waiting = missions.filter((m) => m.pending.decisions + m.pending.provisional + m.pending.reviews > 0);
  if (waiting.length === 0) return null;
  return (
    <section className="mi-wait" aria-label={t("approvals.missions.waiting")}>
      <h2 className="mi-wait__title">{t("approvals.missions.waiting")}</h2>
      <ul className="mi-wait__list">
        {waiting.map((m) => (
          <MissionWaitingRows key={m.id} mission={m} />
        ))}
      </ul>
    </section>
  );
}

function MissionWaitingRows({ mission: m }: { mission: Mission }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const decisions = useMissionDecisions(org.id, m.pending.decisions + m.pending.provisional > 0 ? m.id : null);
  const reviews = useMissionReviews(org.id, m.pending.reviews > 0 ? m.id : null);
  const rows: { key: string; icon: IconName; kind: string; text: string; messageId: string | null; at: string }[] = [
    ...(decisions.data ?? [])
      .filter((d) => d.status !== "taken")
      .map((d) => ({
        key: `d:${d.id}`,
        icon: "waiting" as IconName,
        kind: d.status === "provisional" ? t("approvals.missions.provisional") : t("approvals.missions.decision"),
        text: d.question,
        messageId: d.messageId,
        at: d.createdAt,
      })),
    ...(reviews.data ?? [])
      .filter((r) => r.status === "pending")
      .map((r) => ({
        key: `r:${r.id}`,
        icon: "checks" as IconName,
        kind: t("approvals.missions.review"),
        text: r.title,
        messageId: r.messageId,
        at: r.createdAt,
      })),
  ];
  return (
    <>
      {rows.map((row) => (
        <li key={row.key} className="mi-wait__row">
          <span className="mi-wait__icon" aria-hidden="true">
            <Icon name={row.icon} size={16} />
          </span>
          <span className="mi-wait__t">
            <b>{row.text}</b>
            <small>
              <Chip icon={row.icon}>{row.kind}</Chip>
              <MissionContext mission={m} />
              <span>{relativeTime(t, i18n.language, row.at)}</span>
            </small>
          </span>
          <Link
            to="/org/$orgId/threads/$threadId"
            params={{ orgId: org.id, threadId: m.threadId }}
            search={row.messageId ? { m: row.messageId } : {}}
            className="ac-btn ac-btn--sm"
          >
            {t("approvals.missions.open")}
          </Link>
        </li>
      ))}
    </>
  );
}
