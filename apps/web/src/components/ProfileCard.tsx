import type { Actor, Agent } from "@agenteschat/client";
import { useAgentDetail, useModels, usePeople, useRoles, useSettings } from "@agenteschat/client";
import { audienceNotice, audienceSummary, canTalk, modeOf } from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { formatPercent, formatTime, relativeTime, shortModel, whenAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { clearsText } from "@agenteschat/client/lib/presence";
import { isAuto } from "@agenteschat/client/lib/providers";
import { rolesOf } from "@agenteschat/client/lib/roles";
import { timezoneName } from "@agenteschat/client/lib/routines";
import { Avatar, Button, hoverPointer, Meter, PlanMeter, Popover, ProviderLogo } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { NoAiChip } from "@/components/NoAi";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { type AgentShown, agentLine, personLine, useAgentPresence, usePersonPresence } from "@/hooks/usePresence";
import { planMeterText, usageShown } from "@/lib/plan-usage";

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
      onContentPointerEnter={(e) => hoverPointer(e.pointerType) && clear()}
      onContentPointerLeave={(e) => hoverPointer(e.pointerType) && later(false, HOVER_CLOSE_MS)}
      trigger={
        <button
          type="button"
          className={className ? `profile-trigger ${className}` : "profile-trigger"}
          aria-label={label}
          aria-haspopup="dialog"
          tabIndex={decorative ? -1 : undefined}
          aria-hidden={decorative || undefined}
          onPointerEnter={(e) => {
            if (hoverPointer(e.pointerType) && !open) later(true, HOVER_OPEN_MS);
          }}
          onPointerLeave={(e) => {
            if (!hoverPointer(e.pointerType)) return;
            if (open) later(false, HOVER_CLOSE_MS);
            else clear();
          }}
        >
          {children}
        </button>
      }
    >
      {open &&
        (actor.type === "agent" ? (
          <AgentCard agentId={actor.id} onDone={() => setOpen(false)} />
        ) : (
          <PersonCard userId={actor.id} />
        ))}
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
  // Presence and line as the others see them (ADR 0084): a hidden person reads offline, to themselves hidden.
  const shown = usePersonPresence(userId);
  const line = shown?.status ? personLine(shown.status) : null;
  const seen = person?.lastSeenAt
    ? t("presence.seen", { when: relativeTime(t, i18n.language, person.lastSeenAt) })
    : null;
  const member = dir.memberById.get(userId);
  const name = person?.name ?? member?.name ?? t("channel.unknownPerson");
  const role = person?.role ?? member?.role;
  // The roles they hold, top first (ADR 0085); the owner and someone with none keep their membership's word.
  const held = rolesOf({ roleIds: person?.roleIds ?? member?.roleIds }, useRoles(org.id).data?.roles ?? []);
  const roleLine =
    role === "owner" || held.length === 0 ? (role ? t(`roles.${role}`) : null) : held.map((r) => r.name).join(", ");
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
          presence={shown?.presence ?? null}
          presenceLabel={shown ? t(`presence.${shown.presence}`) : undefined}
        />
        <div className="list-col">
          <span className="profile-card__name">{name}</span>
          {roleLine && <span className="small muted">{roleLine}</span>}
        </div>
      </div>
      {line && shown?.status && (
        <div className="profile-card__status">
          <span className="profile-card__status-emoji" aria-hidden="true">
            {line.emoji}
          </span>
          <span>
            {line.text}
            <small>{clearsText(t, i18n.language, shown.status.until)}</small>
          </span>
        </div>
      )}
      <dl className="profile-card__facts">
        {person && shown && (
          <>
            <dt>{t("profile.presence")}</dt>
            <dd>
              {shown.presence !== "offline"
                ? t(`presence.${shown.presence}`)
                : seen
                  ? `${t("presence.offline")} · ${seen}`
                  : t("profile.offline")}
            </dd>
          </>
        )}
        {localTime && (
          <>
            <dt>{t("profile.localTime")}</dt>
            <dd className="tabular">
              {timezone
                ? t("profile.timeIn", { time: localTime, zone: timezoneName(timezone, i18n.language) })
                : localTime}
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

function AgentCard({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.anyAgent(agentId);
  if (!agent) return <p className="small muted">{t("channel.unknownAgent")}</p>;
  // No longer in the team (archived or deleted): who it was, nothing to do with it.
  if (agent.former) {
    return (
      <div className="profile-card__body">
        <div className="profile-card__head">
          <AgentAvatar agentId={agent.id} size="lg" name={agent.name} />
          <div className="list-col">
            <span className="profile-card__name">{agent.name}</span>
            <span className="small muted">{t("profile.former")}</span>
          </div>
        </div>
      </div>
    );
  }
  return <AgentCardBody agent={agent} onDone={onDone} />;
}

function AgentCardBody({ agent, onDone }: { agent: Agent; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const models = useModels();
  const openPanel = useOpenAgentPanel();
  const seesSpend = can(org, "view_usage") || agent.ownerUserId === me.user.id;
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : null;
  const model = isAuto(agent.model)
    ? t("brain.auto.label")
    : (models.data?.models.find((m) => m.id === agent.model)?.label ?? agent.model);
  const thinks =
    agent.brain && agent.brain.kind !== "model"
      ? brainLine(t, agent.brain, model, { owner: owner?.split(" ")[0], agents: dir.agents })
      : null;
  // Its presence from its work and its line (ADR 0084): its own words or what it is doing now.
  const shown = useAgentPresence(agent.id);
  const line = agentLine(t, shown?.line ?? null);
  return (
    <div className="profile-card__body">
      <div className="profile-card__head">
        <AgentAvatar
          agentId={agent.id}
          size="lg"
          name={agent.name}
          presence={shown?.presence ?? null}
          presenceLabel={shown ? t(`presence.${shown.presence}`) : undefined}
        />
        <div className="list-col">
          <span className="profile-card__name">{agent.name}</span>
          <span className="small muted">
            {agent.role ? t("issues.agentRole", { role: agent.role }) : t("profile.agent")}
          </span>
          <NoAiChip agentId={agent.id} />
        </div>
      </div>
      {line && shown?.line && (
        <div className="profile-card__status">
          <span className="profile-card__status-emoji" aria-hidden="true">
            {line.emoji}
          </span>
          <span>
            {line.text}
            <small>
              {shown.line.by === "self" ? t("presence.bySelf", { name: agent.name }) : t("presence.byAuto")}
            </small>
          </span>
        </div>
      )}
      <dl className="profile-card__facts">
        {shown && (
          <>
            <dt>{t("profile.presence")}</dt>
            <dd>{`${t(`presence.${shown.presence}`)} · ${agentWhy(t, i18n.language, shown)}`}</dd>
          </>
        )}
        <dt>{t("profile.owner")}</dt>
        <dd>{owner ?? t("profile.noOwner")}</dd>
        {modeOf(agent) !== "everyone" && (
          <>
            <dt>{t("profile.audience")}</dt>
            <dd>{audienceSummary(t, agent, (id) => dir.memberById.get(id)?.name)}</dd>
          </>
        )}
        <dt>{t("profile.model")}</dt>
        <dd>
          {thinks ? (
            <span className="profile-card__brain ac-iconline">
              {thinks.mark && <ProviderLogo id={thinks.mark} size="xs" />}
              {thinks.text}
            </span>
          ) : (
            shortModel(model)
          )}
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
        {/* In a conversation, its page opens in the panel beside it; elsewhere, the page. */}
        {openPanel ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onDone();
              openPanel(agent.id);
            }}
          >
            {t("profile.viewProfile")}
          </Button>
        ) : (
          <Button asChild size="sm" variant="ghost">
            <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
              {t("profile.viewProfile")}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/** Why an agent reads as it does: "Ativo agora", "Num trabalho pesado", "Parado desde 14:20", "Sem IA conectada". */
function agentWhy(t: TFunction, locale: string, shown: AgentShown) {
  if (shown.noAi) return t("presence.agentWhy.noAi");
  if (shown.presence !== "away") return t(`presence.agentWhy.${shown.presence}`);
  if (!shown.activeAt) return t("presence.agentWhy.awayNever");
  const today = new Date(shown.activeAt).toDateString() === new Date().toDateString();
  return t("presence.agentWhy.away", {
    when: today ? formatTime(locale, shown.activeAt) : whenAt(t, locale, shown.activeAt),
  });
}

function Spend({ agent, locale }: { agent: Agent; locale: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const detail = useAgentDetail(org.id, agent.id);
  if (!detail.data) return null;
  // A percentage of its budget, never money (owners who aren't admins see this too); on a plan, its limits first
  // and the budget only once it spent through the API (ADR 0063 §5).
  const used = detail.data.budgetUsedPercent;
  const shown = usageShown(agent.brain, used);
  if (!shown.plan && !shown.budget) return null;
  return (
    <div className="stack-4" style={{ gap: 4 }}>
      {shown.plan && (
        <PlanMeter compact usage={shown.plan.usage} text={planMeterText(t, locale)} label={shown.plan.account} />
      )}
      {shown.budget && (
        <span className="small">{t("profile.budgetUsed", { percent: formatPercent(locale, used) })}</span>
      )}
      {shown.budget && !shown.plan && <Meter value={Math.min(100, used)} max={100} label={t("profile.spendLabel")} />}
    </div>
  );
}
