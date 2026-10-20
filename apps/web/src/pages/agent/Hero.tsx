import { useAgentDetail, useChannels, useDms, useMemory, useRuns, useUsage } from "@agenteschat/client";
import { formatMonth, formatPercent, formatUsd } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type AgentColor, Button, Icon, type IconName, Menu, MenuItem, Meter } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usd } from "@/components/AgentFields";
import { useMediaQuery } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { AgentCover } from "@/components/Sky";
import { thisMonth } from "@/lib/agent-edit";
import { useToast } from "@/lib/toast";
import { useStreams } from "@/realtime/context";
import { useAgentEdit } from "./context";
import { WorkSentence } from "./Work";

const LIVE = new Set(["running", "queued", "thinking", "waiting_approval"]);

/** The agent's live run, if any: "status|channelId|connector" (a string, so the selector is stable). */
function useLiveRun(agentId: string) {
  const key = useStreams((s) => {
    let found: { status: string; channelId: string; connector: string } | null = null;
    for (const r of Object.values(s.runs)) {
      if (r.agentId !== agentId || !LIVE.has(r.status)) continue;
      // Working beats waiting.
      if (!found || found.status === "waiting_approval")
        found = { status: r.status, channelId: r.channelId, connector: r.connector ?? "" };
    }
    return found ? `${found.status}|${found.channelId}|${found.connector}` : "";
  });
  if (!key) return null;
  const [status = "", channelId = "", connector = ""] = key.split("|");
  return { status, channelId, connector };
}

/** The status pill on the cover: working in #canal, waiting for an approval, or available. */
function useStatus() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const live = useLiveRun(agent.id);
  const detail = useAgentDetail(org.id, agent.id);
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  const pending = detail.data?.pendingApprovals ?? 0;
  if (live && live.status !== "waiting_approval") {
    const channel = channels.data?.find((c) => c.id === live.channelId);
    const dm = (dms.data ?? []).some((d) => d.channelId === live.channelId);
    return {
      kind: "working" as const,
      text: channel && !dm ? t("agentPage.status.workingIn", { channel: channel.name }) : t("agentPage.status.working"),
      sub: live.connector ? t("agentPage.status.using", { tool: live.connector }) : null,
    };
  }
  if (live || pending > 0) {
    return {
      kind: "waiting" as const,
      text: t("agentPage.status.waiting"),
      sub: pending > 0 ? t("agentPage.status.pending", { count: pending }) : null,
    };
  }
  return {
    kind: "idle" as const,
    text: t("agentPage.status.idle"),
    sub: t("agentPage.status.idleSub", { handle: agent.handle }),
  };
}

function Stat({
  icon,
  label,
  value,
  sub,
  meter,
}: {
  icon: IconName;
  label: string;
  value: string;
  sub?: string | null;
  meter?: ReactNode;
}) {
  return (
    <div className="agp-stat">
      <small>
        <Icon name={icon} size={14} />
        {label}
      </small>
      <b>
        {value}
        {sub && <em>{sub}</em>}
      </b>
      {meter}
    </div>
  );
}

/** Runs, budget (money for admins, % for everyone else) and lessons: on the sky, or below it on phones. */
function Stats() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org } = useOrg();
  const { agent, viewer } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const usage = useUsage(org.id);
  const memory = useMemory(org.id, agent.id);
  const runs = useRuns(org.id, agent.id, viewer !== "member");
  const month = formatMonth(locale, new Date());
  const failures = (runs.data ?? []).filter((r) => r.status === "failed" && thisMonth(r.createdAt)).length;
  const used = detail.data?.budgetUsedPercent ?? 0;
  const active = (memory.data ?? []).filter((m) => !m.archived);
  const lessons = active.filter((m) => m.kind === "lesson" || m.kind === "preference").length;
  const facts = active.length - lessons;
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  const meter = <Meter value={Math.min(100, used)} max={100} label={t("agent.budgetUsed")} />;
  return (
    <div className="agp-stats">
      <Stat
        icon="routines"
        label={t("agentPage.stats.runs", { month })}
        value={String(detail.data?.runsThisMonth ?? 0)}
        sub={runs.data ? t("agentPage.stats.failures", { count: failures }) : null}
      />
      {viewer === "admin" && spent !== undefined && limit !== undefined ? (
        <Stat
          icon="wallet"
          label={t("agentPage.stats.spent", { month })}
          value={formatUsd(t, locale, spent)}
          sub={t("agentPage.stats.of", { amount: usd(t, locale, limit) })}
          meter={meter}
        />
      ) : (
        <Stat
          icon="wallet"
          label={t("agentPage.stats.budget")}
          value={formatPercent(locale, used)}
          sub={t("agentPage.stats.used")}
          meter={meter}
        />
      )}
      <Stat
        icon="book"
        label={t("agentPage.stats.lessons")}
        value={String(lessons)}
        sub={t("agentPage.stats.facts", { count: facts })}
      />
    </div>
  );
}

/**
 * The cover: the agent on its own-color sky with its status, key numbers and
 * the actions in its corner; then its name, @ and role, and what it works with
 * as one sentence (telas/PerfilAgente.html).
 */
export function AgentHero({ onArchive }: { onArchive: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const { agent, draft, viewer, goTo, saved, openWork } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const status = useStatus();
  const narrow = useMediaQuery("(max-width: 900px)");
  const busy = status.kind === "working";
  const name = draft.name.trim() || agent.name;
  const channelNames = (detail.data?.channels ?? []).filter((c) => saved.channels?.includes(c.id) ?? true);
  const home = channelNames[0];
  const g = agentGrammar(t, agent.name);
  return (
    <header className="agp-hero">
      <div className="agp-cover" data-busy={busy || undefined}>
        <AgentCover color={draft.look.color as AgentColor} busy={busy} />
        <span className="agp-state" data-kind={status.kind}>
          <span className="agp-state__ico" aria-hidden="true">
            {status.kind === "working" ? (
              <span className="agp-bars">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <Icon name={status.kind === "waiting" ? "lock" : "check"} size={14} />
            )}
          </span>
          {status.text}
          {status.sub && <span className="agp-state__sub">· {status.sub}</span>}
        </span>
        <AgentAvatar agentId={agent.id} appearance={draft.look} size="xl" name={name} className="agp-cover__agent" />
        {!narrow && <Stats />}
        <div className="agp-cover__acts">
          <Button asChild variant="primary" size="sm" className="agp-chat">
            <Link to="/org/$orgId/dm/agent/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
              <Icon name="message" size={14} />
              {t("agent.chat")}
            </Link>
          </Button>
          <Menu
            align="end"
            label={t("agent.moreActions")}
            trigger={
              <Button size="sm" iconOnly icon="more" className="agp-glass" aria-label={t("agent.moreActions")} />
            }
          >
            {home && (
              <MenuItem
                icon="channel"
                onSelect={() =>
                  void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: home.id } })
                }
              >
                {t("agent.openIn", { channel: home.name })}
              </MenuItem>
            )}
            {viewer === "admin" && (
              <MenuItem
                icon="edit"
                onSelect={() => {
                  goTo("settings", "identity");
                  setTimeout(() => document.getElementById("agp-name")?.focus());
                }}
              >
                {t("agent.editIdentity")}
              </MenuItem>
            )}
            <MenuItem icon="book" onSelect={() => goTo("memory")}>
              {t("agent.viewMemory")}
            </MenuItem>
            {viewer !== "member" && (
              <MenuItem icon="routines" onSelect={() => goTo("activity")}>
                {t("agent.viewRuns")}
              </MenuItem>
            )}
            <MenuItem
              icon="copy"
              onSelect={() => {
                void navigator.clipboard?.writeText(`@${agent.handle}`).catch(() => {});
                toast.show(t("agentPage.copied", { handle: agent.handle }));
              }}
            >
              {t("agentPage.copyHandle", { handle: agent.handle })}
            </MenuItem>
            {viewer === "admin" && (
              <MenuItem icon="archive" danger onSelect={onArchive}>
                {t("agentPage.archive.action", g)}
              </MenuItem>
            )}
          </Menu>
        </div>
      </div>
      <div className="agp-ident">
        <div className="agp-who">
          <h1 className="agp-name">{name}</h1>
          <span className="agp-handle">
            @{agent.handle}
            {(draft.role.trim() || agent.role) && ` · ${draft.role.trim() || agent.role}`}
          </span>
          <WorkSentence onOpen={openWork} />
        </div>
      </div>
      {narrow && <Stats />}
    </header>
  );
}
