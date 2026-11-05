import type { Routine, Team, TeamAgent } from "@agenteschat/client";
import { useAgentGroups, useApprovals, useProposeChannelMove, useRoutines } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { mapColumns } from "@agenteschat/client/lib/team-views";
import { excerpt } from "@agenteschat/client/lib/text";
import { Icon } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type DragEvent, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { useWhen } from "@/pages/RoutinesPage";
import { ChannelName, useTeamLookups } from "./shared";

/** "What it does" on a card: its instructions' first line, in whole sentences while they fit. */
const SUMMARY_MAX = 120;
/** Routines shown on a card before "and N more". */
const CARD_ROUTINES = 2;
const NO_CHANNEL = "none";
const AGENT_DRAG = "application/x-agentes-map-agent";

interface Line {
  key: string;
  d: string;
  kind: "owner" | "ask";
}

/**
 * Equipe › Mapa (ADR 0148): the people who look after the agents on top, one column per channel with its agents,
 * what each does on its own (routines) and what waits for a person, dashed lines between agents that asked each
 * other in the last day, and the right hand under them. Read-only: dropping an agent on another channel asks the
 * right hand for a settings card in my DM with it, applied there like any other.
 */
export function TeamMap({ team }: { team: Team }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const groups = useAgentGroups(org.id).data ?? [];
  const look = useTeamLookups(groups);
  const routines = useRoutines(org.id).data ?? [];
  const approvals = useApprovals(org.id).data ?? [];
  const when = useWhen();
  const toast = useToast();
  const navigate = useNavigate();
  const propose = useProposeChannelMove(org.id);
  const columns = mapColumns(team.agents, look.channelOrder, look.isLodi);
  const owners = [
    ...new Set(columns.flatMap((c) => c.agents.map((a) => a.ownerUserId)).filter((id): id is string => !!id)),
  ].filter((id) => look.members.has(id));
  const waiting = (id: string) => approvals.filter((a) => a.agentId === id && a.status === "pending").length;
  // A routine shows in the column of the channel it posts to, else in its agent's first column.
  const routinesIn = (agent: TeamAgent, channelId: string | null, first: boolean) =>
    routines.filter((r) => {
      if (r.agentId !== agent.id || !r.active) return false;
      const target = "channelId" in r.target ? r.target.channelId : null;
      const here = target !== null && agent.channelIds?.includes(target);
      return here ? target === channelId : first;
    });

  const box = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const shape = `${columns.map((c) => `${c.channelId}:${c.agents.map((a) => a.id).join()}`).join("|")}#${team.consultations.length}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the columns or the consultations change
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const rect = (q: string) => el.querySelector<HTMLElement>(q)?.getBoundingClientRect();
      const out: Line[] = [];
      for (const id of owners) {
        const p = rect(`[data-map-person="${id}"]`);
        if (!p) continue;
        const x0 = p.left + p.width / 2 - base.left;
        const y0 = p.bottom - base.top;
        for (const c of columns) {
          if (!c.agents.some((a) => a.ownerUserId === id)) continue;
          const col = rect(`[data-map-col="${c.channelId ?? NO_CHANNEL}"]`);
          if (!col) continue;
          const x1 = col.left + col.width / 2 - base.left;
          const y1 = col.top - base.top;
          const mid = (y0 + y1) / 2;
          out.push({
            key: `o-${id}-${c.channelId}`,
            kind: "owner",
            d: `M${x0},${y0} C${x0},${mid} ${x1},${mid} ${x1},${y1}`,
          });
        }
      }
      const pairs = new Set<string>();
      for (const c of team.consultations) {
        const key = [c.askerAgentId, c.targetAgentId].sort().join("|");
        if (pairs.has(key)) continue;
        pairs.add(key);
        const a = rect(`[data-map-agent="${c.askerAgentId}"]`);
        const b = rect(`[data-map-agent="${c.targetAgentId}"]`);
        if (!a || !b) continue;
        if (Math.abs(a.left - b.left) < 4) {
          // The same column: a loop out of their right edges.
          const x = a.right - base.left;
          const ya = a.top + a.height / 2 - base.top;
          const yb = b.top + b.height / 2 - base.top;
          out.push({ key: `a-${key}`, kind: "ask", d: `M${x},${ya} C${x + 28},${ya} ${x + 28},${yb} ${x},${yb}` });
          continue;
        }
        const [l, r] = a.left <= b.left ? [a, b] : [b, a];
        const x0 = l.right - base.left;
        const y0 = l.top + l.height / 2 - base.top;
        const x1 = r.left - base.left;
        const y1 = r.top + r.height / 2 - base.top;
        out.push({
          key: `a-${key}`,
          kind: "ask",
          d: `M${x0},${y0} C${(x0 + x1) / 2},${y0} ${(x0 + x1) / 2},${y1} ${x1},${y1}`,
        });
      }
      setLines(out);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shape, owners.join()]);

  const [dragging, setDragging] = useState<{ agentId: string; from: string | null } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drop = (to: string) => {
    if (!dragging) return;
    const { agentId, from } = dragging;
    setDragging(null);
    setOver(null);
    const agent = team.agents.find((a) => a.id === agentId);
    if (!agent || agent.channelIds?.includes(to)) return;
    const toName = look.channelById.get(to)?.name ?? "";
    const fromName = from ? (look.channelById.get(from)?.name ?? "") : "";
    propose.mutate(
      {
        agentId,
        fromChannelId: from,
        toChannelId: to,
        reason: from
          ? t("team.map.reasonMove", { agent: agent.name, from: fromName, to: toName })
          : t("team.map.reasonJoin", { agent: agent.name, to: toName }),
      },
      {
        onError: (e) => toast.show(errorText(t, e), "error"),
        onSuccess: (r) =>
          toast.show(t("team.map.proposed", { name: look.lodi?.name ?? "" }), "success", {
            label: t("team.map.open"),
            run: () =>
              void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: r.rightHandId } }),
          }),
      },
    );
  };
  const zone = (channelId: string | null) =>
    channelId === null
      ? {}
      : {
          "data-drop": over === channelId || undefined,
          onDragOver: (e: DragEvent<HTMLElement>) => {
            if (!dragging || dragging.from === channelId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (over !== channelId) setOver(channelId);
          },
          onDragLeave: (e: DragEvent<HTMLElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === channelId ? null : o));
          },
          onDrop: (e: DragEvent<HTMLElement>) => {
            e.preventDefault();
            drop(channelId);
          },
        };

  if (columns.length === 0) return <p className="team-empty">{t("team.map.empty")}</p>;
  // Channels with no agent yet: chips under the columns, to drop an agent on.
  const others = look.channelOrder.filter((id) => !columns.some((c) => c.channelId === id));
  const seen = new Set<string>();
  return (
    <section className="team-map" aria-label={t("team.view.map")}>
      <p className="muted team-map__lead">{t("team.map.lead")}</p>
      <div className="team-map__canvas" ref={box}>
        <svg className="team-map__lines" aria-hidden="true">
          {lines.map((l) => (
            <path key={l.key} d={l.d} data-kind={l.kind} />
          ))}
        </svg>
        {owners.length > 0 && (
          <div className="team-map__people">
            {owners.map((id) => {
              const m = look.dir.memberById.get(id);
              return (
                <span key={id} className="team-node team-node--person" data-map-person={id}>
                  <PersonAvatar id={id} name={m?.name ?? ""} size="sm" presence />
                  <span className="team-node__text">
                    <b className="ac-captop">{m?.name}</b>
                    <span className="muted">{m ? t(`roles.${m.role}`) : ""}</span>
                  </span>
                </span>
              );
            })}
          </div>
        )}
        <div className="team-map__cols">
          {columns.map((c) => {
            const channel = c.channelId ? look.channelById.get(c.channelId) : undefined;
            return (
              <section
                key={c.channelId ?? NO_CHANNEL}
                className="team-map__col"
                data-map-col={c.channelId ?? NO_CHANNEL}
                data-none={c.channelId ? undefined : ""}
                aria-label={channel ? `#${channel.name}` : t("team.list.noChannel")}
                {...zone(c.channelId)}
              >
                <header className="team-map__head">
                  {channel ? (
                    <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: channel.id }}>
                      <ChannelName name={channel.name} private={channel.visibility === "private"} />
                    </Link>
                  ) : (
                    <span className="muted">{t("team.list.noChannel")}</span>
                  )}
                </header>
                {c.agents.map((a) => {
                  const first = !seen.has(a.id);
                  seen.add(a.id);
                  return (
                    <MapCard
                      key={a.id}
                      agent={a}
                      first={first}
                      routines={routinesIn(a, c.channelId, first)}
                      when={when}
                      waiting={first ? waiting(a.id) : 0}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(AGENT_DRAG, a.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragging({ agentId: a.id, from: c.channelId });
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                    />
                  );
                })}
              </section>
            );
          })}
        </div>
        {others.length > 0 && (
          <div className="team-map__others">
            <span className="muted">{t("team.map.others")}</span>
            {others.map((id) => {
              const channel = look.channelById.get(id);
              return (
                channel && (
                  <span key={id} className="team-chip team-map__drop" data-map-col={id} {...zone(id)}>
                    <ChannelName name={channel.name} private={channel.visibility === "private"} />
                  </span>
                )
              );
            })}
          </div>
        )}
        {look.lodi && (
          <Link
            to="/org/$orgId/dm/agent/$agentId"
            params={{ orgId: org.id, agentId: look.lodi.id }}
            className="team-node team-node--lodi team-map__lodi"
          >
            <AgentAvatar agentId={look.lodi.id} name={look.lodi.name} size="sm" />
            <span className="team-node__text">
              <b className="ac-captop">{look.lodi.name}</b>
              <span className="muted">{t("team.map.lodi")}</span>
            </span>
          </Link>
        )}
      </div>
      <p className="team-map__hint muted">
        <Icon name="arrowRight" size={14} />
        {t("team.map.hint", { name: look.lodi?.name ?? "" })}
      </p>
    </section>
  );
}

function MapCard({
  agent,
  first,
  routines,
  when,
  waiting,
  onDragStart,
  onDragEnd,
}: {
  agent: TeamAgent;
  first: boolean;
  routines: Routine[];
  when: (r: Routine) => string;
  waiting: number;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const groups = useAgentGroups(org.id).data ?? [];
  const look = useTeamLookups(groups);
  const summary = excerpt(look.dir.agentById.get(agent.id)?.instructions ?? "", SUMMARY_MAX, 1);
  return (
    <article
      className="team-map__card"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      data-map-agent={first ? agent.id : undefined}
    >
      <Link
        to="/org/$orgId/agents/$agentId"
        params={{ orgId: org.id, agentId: agent.id }}
        className="team-map__who"
        draggable={false}
      >
        <AgentAvatar agentId={agent.id} name={agent.name} size="md" />
        <span className="team-node__text">
          <b className={agent.role ? "ac-captop" : undefined}>{agent.name}</b>
          {agent.role && <span className="muted">{agent.role}</span>}
        </span>
      </Link>
      {first && summary && <p className="team-map__does">{summary}</p>}
      {(routines.length > 0 || waiting > 0) && (
        <ul className="team-map__facts">
          {routines.slice(0, CARD_ROUTINES).map((r) => (
            <li key={r.id} className="ac-iconline">
              <Icon name="routines" size={14} />
              <span>
                {when(r)} · {r.name}
              </span>
            </li>
          ))}
          {routines.length > CARD_ROUTINES && (
            <li className="muted">{t("team.map.moreRoutines", { count: routines.length - CARD_ROUTINES })}</li>
          )}
          {waiting > 0 && (
            <li data-tone="waiting" className="ac-iconline">
              <Icon name="shield" size={14} />
              <span>{t("team.map.waiting", { count: waiting })}</span>
            </li>
          )}
        </ul>
      )}
    </article>
  );
}
