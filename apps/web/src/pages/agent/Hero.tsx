import { useAgentDetail, useMemory, useRuns, useUsage } from "@agenteschat/client";
import { formatMonth, formatPercent, formatUsd } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type AgentColor, Button, Icon, Menu, MenuItem, Meter, PlanMeter } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usd } from "@/components/AgentFields";
import { NoAiChip } from "@/components/NoAi";
import { useOrg } from "@/components/org-context";
import { AgentCover } from "@/components/Sky";
import { thisMonth } from "@/lib/agent-edit";
import { planMeterText, usageShown } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { useStreams } from "@/realtime/context";
import { useAgentEdit } from "./context";
import { WorkCard } from "./Work";

const LIVE = new Set(["running", "queued", "thinking", "waiting_approval"]);

/**
 * Opens the name's field in Configurações › Identidade e jeito (it edits in place: its button turns into the field,
 * which takes the focus), trying a few times while the tab shows.
 */
function editNameSoon(tries = 5) {
  setTimeout(() => {
    const name = document.getElementById("agp-name");
    if (name instanceof HTMLInputElement) name.focus();
    else if (name) name.click();
    else if (tries > 1) editNameSoon(tries - 1);
  });
}

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

/**
 * Runs, usage and lessons: quiet lines under "Como trabalha". Usage is its plan's limits on a plan, and the
 * budget (money for admins, % for everyone else) on the API or once a plan agent spent through it (ADR 0063 §5).
 */
export function Numbers() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org } = useOrg();
  const { agent, viewer, goTo } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const usage = useUsage(org.id);
  const memory = useMemory(org.id, agent.id);
  const runs = useRuns(org.id, agent.id, viewer !== "member");
  const month = formatMonth(locale, new Date());
  const failures = (runs.data ?? []).filter((r) => r.status === "failed" && thisMonth(r.createdAt)).length;
  const used = detail.data?.budgetUsedPercent ?? 0;
  const shown = usageShown(agent.brain, used);
  const active = (memory.data ?? []).filter((m) => !m.archived);
  const lessons = active.filter((m) => m.kind === "lesson" || m.kind === "preference").length;
  const facts = active.length - lessons;
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  const money = viewer === "admin" && spent !== undefined && limit !== undefined;
  return (
    <p className="agp-numbers">
      <button type="button" className="agp-number" onClick={() => goTo("activity")}>
        <Icon name="routines" size={14} />
        <span>
          {t("agentPage.numbers.runs", { count: detail.data?.runsThisMonth ?? 0, month })}
          {runs.data && ` · ${t("agentPage.stats.failures", { count: failures })}`}
        </span>
      </button>
      {shown.plan && (
        <button type="button" className="agp-number" onClick={() => goTo("usage")}>
          <Icon name="clock" size={14} />
          <PlanMeter compact usage={shown.plan.usage} text={planMeterText(t, locale)} label={shown.plan.account} />
        </button>
      )}
      {shown.budget && (
        <button type="button" className="agp-number" onClick={() => goTo("settings", "budget")}>
          <Icon name="wallet" size={14} />
          <span>
            {money
              ? `${formatUsd(locale, spent)} ${t("agentPage.stats.of", { amount: usd(t, locale, limit) })}`
              : t("agentPage.numbers.budget", { percent: formatPercent(locale, used) })}
          </span>
          <Meter value={Math.min(100, used)} max={100} label={t("agent.budgetUsed")} />
        </button>
      )}
      <button type="button" className="agp-number" onClick={() => goTo("memory")}>
        <Icon name="book" size={14} />
        <span>
          {t("agentPage.numbers.lessons", { count: lessons })} {t("agentPage.stats.facts", { count: facts })}
        </span>
      </button>
    </p>
  );
}

/** `onClose` / `onExpand`: in the panel beside its DM, where "Conversar" is the conversation next to it. */
export function AgentHero({
  onArchive,
  onClose,
  onExpand,
}: {
  onArchive: () => void;
  onClose?: () => void;
  onExpand?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const { agent, draft, viewer, goTo, saved, openWork, workInAside } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const live = useLiveRun(agent.id);
  const busy = Boolean(live && live.status !== "waiting_approval");
  const name = draft.name.trim() || agent.name;
  const channelNames = (detail.data?.channels ?? []).filter((c) => saved.channels?.includes(c.id) ?? true);
  const home = channelNames[0];
  const g = agentGrammar(agent.name);
  const face = useRef<HTMLSpanElement>(null);
  const acts = useRef<HTMLDivElement>(null);
  return (
    <header className="agp-hero">
      {/* Open sky: the cover edge to edge, the agent on its left edge, no card. */}
      <section className="agp-idcard" aria-label={name}>
        <div className="agp-cover" data-busy={busy || undefined}>
          <AgentCover color={draft.look.color as AgentColor} busy={busy} clear={() => [face.current, acts.current]} />
          <div className="agp-cover__acts" ref={acts}>
            {!onClose && (
              <Button asChild variant="primary" size="sm" className="agp-chat">
                <Link to="/org/$orgId/dm/agent/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
                  <Icon name="message" size={14} />
                  {t("agent.chat")}
                </Link>
              </Button>
            )}
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
                    editNameSoon();
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
            {onExpand && (
              <Button
                size="sm"
                iconOnly
                icon="external"
                className="agp-glass"
                aria-label={t("agentPage.panel.expand")}
                title={t("agentPage.panel.expand")}
                onClick={onExpand}
              />
            )}
            {onClose && (
              <Button
                size="sm"
                iconOnly
                icon="close"
                className="agp-glass"
                aria-label={t("common.close")}
                title={t("common.close")}
                onClick={onClose}
              />
            )}
          </div>
        </div>
        {/* Over the cover's left edge, cut out by a ring of the page. */}
        <span className="agp-face" ref={face}>
          <AgentAvatar agentId={agent.id} appearance={draft.look} size="xl" name={name} />
        </span>
        <div className="agp-ident">
          <h1 className="agp-name">{name}</h1>
          <span className="agp-handle">
            @{draft.handle || agent.handle}
            {(draft.role.trim() || agent.role) && ` · ${draft.role.trim() || agent.role}`}
          </span>
          <NoAiChip agentId={agent.id} />
        </div>
        {/* Narrow (the panel beside its DM, small screens): how it works stays up here, on every tab. Wide, it
            is the overview's side column (OverviewTab). In the panel the numbers stay on the full page. */}
        {!workInAside && (
          <div className="agp-hero__work">
            <WorkCard onOpen={openWork} footer={onClose ? null : <Numbers />} />
          </div>
        )}
      </section>
    </header>
  );
}
