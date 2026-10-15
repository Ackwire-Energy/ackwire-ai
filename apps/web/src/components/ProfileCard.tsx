import { Avatar, Button, Meter, Popover } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentDetail, useAgentScopes, useModels, usePeople, useSettings } from "@/api/queries";
import type { Actor, Agent } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useScopeGroups } from "@/hooks/useScopeGroups";
import { audienceNotice, audienceSummary, canTalk, modeOf } from "@/lib/audience";
import { formatUsd, relativeTime, shortModel } from "@/lib/format";
import { can } from "@/lib/permissions";
import { scopeSummary } from "@/lib/scopes";

/** Hover delay before the card opens (mouse and pen only; touch opens on tap). */
export const HOVER_OPEN_MS = 400;
const HOVER_CLOSE_MS = 200;

/**
 * Wraps an avatar, author name or mention so it opens the profile card:
 * click, Enter/Space, or ~400 ms of hover with a mouse. Never on touch hover.
 */
export function ProfileTrigger({
  actor,
  label,
  children,
  className,
  decorative,
}: {
  actor: Actor;
  /** Accessible name of the button ("Perfil de Ada"). */
  label: string;
  children: ReactNode;
  className?: string;
  /** A second trigger next to a focusable one (the avatar beside the name): mouse only. */
  decorative?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // Drop a pending hover timer on unmount.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const hoverable = (e: PointerEvent) => e.pointerType === "mouse" || e.pointerType === "pen";
  const later = (next: boolean, ms: number) => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(next);
    }, ms);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        clear();
        setOpen(o);
      }}
      label={t("profile.cardLabel")}
      side="bottom"
      className="profile-card"
      onContentPointerEnter={(e) => hoverable(e) && clear()}
      onContentPointerLeave={(e) => hoverable(e) && later(false, HOVER_CLOSE_MS)}
      trigger={
        <button
          type="button"
          className={className ? `profile-trigger ${className}` : "profile-trigger"}
          aria-label={label}
          aria-haspopup="dialog"
          tabIndex={decorative ? -1 : undefined}
          aria-hidden={decorative || undefined}
          onPointerEnter={(e) => {
            if (hoverable(e) && !open) later(true, HOVER_OPEN_MS);
          }}
          onPointerLeave={(e) => {
            if (!hoverable(e)) return;
            if (open) later(false, HOVER_CLOSE_MS);
            else clear();
          }}
        >
          {children}
        </button>
      }
    >
      {open && (actor.type === "agent" ? <AgentCard agentId={actor.id} /> : <PersonCard userId={actor.id} />)}
    </Popover>
  );
}

function PersonCard({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const people = usePeople(org.id);
  const settings = useSettings(org.id);
  const dir = useDirectory(org.id);
  const person = people.data?.find((p) => p.userId === userId);
  const member = dir.memberById.get(userId);
  const name = person?.name ?? member?.name ?? t("channel.unknownPerson");
  const role = person?.role ?? member?.role;
  // The person's own zone (the API falls back to the workspace's).
  const timezone = person?.timezone ?? member?.timezone ?? settings.data?.timezone;
  let localTime: string | null = null;
  try {
    localTime = new Intl.DateTimeFormat(i18n.language, {
      hour: "2-digit",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(new Date());
  } catch {
    localTime = null;
  }
  return (
    <div className="profile-card__body">
      <div className="profile-card__head">
        <Avatar
          kind="person"
          size="lg"
          name={name}
          imageUrl={person?.image ?? member?.image}
          presence={person?.online}
        />
        <div className="list-col">
          <span className="profile-card__name">{name}</span>
          {role && <span className="small muted">{t(`roles.${role}`)}</span>}
        </div>
      </div>
      <dl className="profile-card__facts">
        {person && (
          <>
            <dt>{t("profile.presence")}</dt>
            <dd>
              {person.online
                ? t("members.activeNow")
                : person.lastSeenAt
                  ? t("members.seen", { when: relativeTime(t, i18n.language, person.lastSeenAt) })
                  : t("profile.offline")}
            </dd>
          </>
        )}
        {localTime && (
          <>
            <dt>{t("profile.localTime")}</dt>
            <dd className="tabular">
              {timezone ? t("profile.timeIn", { time: localTime, zone: timezone }) : localTime}
            </dd>
          </>
        )}
      </dl>
      {userId !== me.user.id && (
        <div className="profile-card__actions">
          <Button asChild size="sm" variant="primary">
            <Link to="/org/$orgId/dm/person/$userId" params={{ orgId: org.id, userId }}>
              {t("profile.dm")}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentCard({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(agentId);
  if (!agent) return <p className="small muted">{t("channel.unknownAgent")}</p>;
  return <AgentCardBody agent={agent} />;
}

function AgentCardBody({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const models = useModels();
  const grants = useAgentScopes(org.id, agent.id);
  const groups = useScopeGroups(org.id);
  const seesSpend = can(org.role, "view_usage") || agent.ownerUserId === me.user.id;
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : null;
  const model = models.data?.models.find((m) => m.id === agent.model)?.label ?? agent.model;
  const summary = groups && grants.data ? scopeSummary(groups, grants.data, t("agent.noPermission")) : null;
  const allowed = summary?.rows.filter((r) => r.granted !== t("agent.noPermission")).slice(0, 3) ?? [];
  return (
    <div className="profile-card__body">
      <div className="profile-card__head">
        <Avatar kind="agent" size="lg" name={agent.name} initials={dir.agentInitials(agent.id)} />
        <div className="list-col">
          <span className="profile-card__name">{agent.name}</span>
          <span className="small muted">
            {agent.role ? t("issues.agentRole", { role: agent.role }) : t("profile.agent")}
          </span>
        </div>
      </div>
      <dl className="profile-card__facts">
        <dt>{t("profile.owner")}</dt>
        <dd>{owner ?? t("profile.noOwner")}</dd>
        {modeOf(agent) !== "everyone" && (
          <>
            <dt>{t("profile.audience")}</dt>
            <dd>{audienceSummary(t, agent, (id) => dir.memberById.get(id)?.name)}</dd>
          </>
        )}
        <dt>{t("profile.model")}</dt>
        <dd>{shortModel(model)}</dd>
        <dt>{t("profile.can")}</dt>
        <dd>
          {summary === null
            ? "…"
            : allowed.length === 0
              ? t("agent.noPermission")
              : allowed.map((r) => `${r.name}: ${r.granted}`).join("; ")}
        </dd>
      </dl>
      {seesSpend && <Spend agent={agent} locale={i18n.language} />}
      {!canTalk(agent) && (
        <p className="small muted">{audienceNotice(t, agent, (id) => dir.memberById.get(id)?.name)}</p>
      )}
      <div className="profile-card__actions">
        <Button asChild size="sm" variant="primary">
          <Link to="/org/$orgId/dm/agent/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
            {t("profile.dm")}
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
            {t("profile.viewProfile")}
          </Link>
        </Button>
      </div>
    </div>
  );
}

function Spend({ agent, locale }: { agent: Agent; locale: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const detail = useAgentDetail(org.id, agent.id);
  if (!detail.data) return null;
  const spent = detail.data.spentThisMonthUsd;
  const budget = detail.data.monthlyBudgetUsd;
  return (
    <div className="stack-4" style={{ gap: 4 }}>
      <span className="small">
        {budget
          ? t("profile.spendOf", { spent: formatUsd(t, locale, spent), budget: formatUsd(t, locale, budget) })
          : t("profile.spend", { spent: formatUsd(t, locale, spent) })}
      </span>
      {budget ? <Meter value={spent} max={budget} label={t("profile.spendLabel")} /> : null}
    </div>
  );
}
