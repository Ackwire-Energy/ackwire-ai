import { Button, Card, Chip, Icon, SearchInput, Segmented } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentDetail, useChannels, useRoutines, useRuns, useUsage } from "@/api/queries";
import type { Run } from "@/api/types";
import { usd } from "@/components/AgentFields";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { groupByDay, isRoutineRun, type RunFilter, runMatches, thisMonth } from "@/lib/agent-edit";
import {
  dayLabel,
  formatInt,
  formatMonth,
  formatPercent,
  formatTime,
  formatTokensShort,
  formatUsd,
} from "@/lib/format";
import { useAgentEdit } from "./context";
import { RunChip, runWhere } from "./pieces";

/** How many runs show at first, and how many more each "Carregar mais". */
export const RUNS_PAGE = 20;

type TT = (key: string, options?: Record<string, unknown>) => string;

/** Why a run failed, in the person's language (the server's code), else its own words. */
function failure(t: TFunction, run: Run) {
  const code = run.errorCode?.replace(/^run\./, "");
  if (code && code !== "failed") {
    const text = (t as unknown as TT)(`agentPage.activity.errors.${code}`, { ...run.errorParams, defaultValue: "" });
    if (text) return text;
  }
  return run.errorParams?.detail ?? run.error ?? t("agentPage.activity.errors.unknown");
}

/** Atividade: this month's runs by day, with search and filters (all, failures, waiting, routines). */
export function ActivityTab() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org } = useOrg();
  const { agent, viewer, ownerFirst } = useAgentEdit();
  const allowed = viewer !== "member";
  const runs = useRuns(org.id, agent.id, allowed);
  const detail = useAgentDetail(org.id, agent.id);
  const channels = useChannels(org.id);
  const routines = useRoutines(org.id);
  const usage = useUsage(org.id);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<RunFilter>("all");
  const [shown, setShown] = useState(RUNS_PAGE);
  const prompts = useMemo(
    () => (routines.data ?? []).filter((r) => r.agentId === agent.id).map((r) => r.prompt),
    [routines.data, agent.id],
  );
  const month = formatMonth(locale, new Date());
  if (!allowed) {
    return (
      <Card className="agp-card">
        <div className="agp-empty">
          <Icon name="lock" />
          <b>{t("agentPage.activity.hidden", { owner: ownerFirst ?? t("roles.adminLower") })}</b>
        </div>
      </Card>
    );
  }
  // Newest first (the day groups rely on it).
  const list = [...(runs.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const extra = (r: Run) => ({
    where: runWhere(t, r, channels.data ?? []),
    routine: isRoutineRun(r, prompts, agent.handle),
  });
  const filtered = list.filter((r) => runMatches(r, filter, q, extra(r)));
  const visible = filtered.slice(0, shown);
  const failures = list.filter((r) => r.status === "failed").length;
  const waiting = list.filter((r) => r.status === "waiting_approval" || r.status === "waiting_input").length;
  const routineCount = list.filter((r) => extra(r).routine).length;
  const monthFailures = list.filter((r) => r.status === "failed" && thisMonth(r.createdAt)).length;
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  const used = detail.data?.budgetUsedPercent ?? 0;
  const days = groupByDay(visible);
  return (
    <>
      <div className="agp-tiles agp-tiles--four">
        <div className="agp-tile">
          <small>
            <Icon name="routines" size={14} />
            {t("agentPage.activity.runs")}
          </small>
          <b>{formatInt(locale, detail.data?.runsThisMonth ?? 0)}</b>
          <span>{t("agentPage.activity.inMonth", { month })}</span>
        </div>
        <div className="agp-tile">
          <small>
            <Icon name="document" size={14} />
            {t("agentPage.activity.tokens")}
          </small>
          <b>{formatTokensShort(t, locale, detail.data?.tokensThisMonth ?? 0)}</b>
          <span>{t("agentPage.activity.tokensHelp")}</span>
        </div>
        <div className="agp-tile">
          <small>
            <Icon name="alert" size={14} />
            {t("agentPage.activity.failures")}
          </small>
          <b>{monthFailures}</b>
          <span>{t("agentPage.activity.inMonth", { month })}</span>
        </div>
        {viewer === "admin" && spent !== undefined && limit !== undefined ? (
          <div className="agp-tile">
            <small>
              <Icon name="wallet" size={14} />
              {t("agentPage.activity.spent")}
            </small>
            <b>{formatUsd(t, locale, spent)}</b>
            <span>{t("agentPage.stats.of", { amount: usd(t, locale, limit) })}</span>
          </div>
        ) : (
          <div className="agp-tile">
            <small>
              <Icon name="wallet" size={14} />
              {t("agentPage.stats.budget")}
            </small>
            <b>{formatPercent(locale, used)}</b>
            <span>{t("agent.usageHidden")}</span>
          </div>
        )}
      </div>
      <Card as="section" className="agp-card" aria-label={t("agentPage.activity.title")}>
        <div className="agp-toolbar agp-toolbar--in">
          <SearchInput
            className="agp-search"
            aria-label={t("agent.runsSearch")}
            placeholder={t("agent.runsPlaceholder")}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setShown(RUNS_PAGE);
            }}
          />
          <Segmented
            size="sm"
            label={t("agentPage.activity.filter")}
            value={filter}
            onValueChange={(f) => {
              setFilter(f);
              setShown(RUNS_PAGE);
            }}
            options={[
              { value: "all" as const, label: t("agentPage.activity.filters.all") },
              {
                value: "failed" as const,
                label: (
                  <>
                    {t("agentPage.activity.filters.failed")} <span className="agp-cnt">{failures}</span>
                  </>
                ),
              },
              {
                value: "waiting" as const,
                label: (
                  <>
                    {t("agentPage.activity.filters.waiting")} <span className="agp-cnt">{waiting}</span>
                  </>
                ),
              },
              {
                value: "routines" as const,
                label: (
                  <>
                    {t("agentPage.activity.filters.routines")} <span className="agp-cnt">{routineCount}</span>
                  </>
                ),
              },
            ]}
          />
        </div>
        {runs.isLoading ? (
          <LoadingList count={4} />
        ) : visible.length === 0 ? (
          <div className="agp-empty">
            <b>
              {q.trim()
                ? t("agent.runsEmpty", { q })
                : list.length === 0
                  ? t("agent.runsNone")
                  : t("agentPage.activity.noneFilter")}
            </b>
            {(q.trim() || filter !== "all") && <span className="small muted">{t("agentPage.activity.clear")}</span>}
          </div>
        ) : (
          <div className="agp-runs">
            {days.map((d) => (
              <section key={d.day} className="agp-day" aria-label={dayLabel(t, locale, d.runs[0]?.createdAt ?? "")}>
                <h3 className="agp-day__label">{dayLabel(t, locale, d.runs[0]?.createdAt ?? "")}</h3>
                <ul className="agp-list">
                  {d.runs.map((r) => {
                    const x = extra(r);
                    return (
                      <li key={r.id} className="agp-run">
                        <time dateTime={r.createdAt}>{formatTime(locale, r.createdAt)}</time>
                        <span className="agp-run__t">
                          <b>{r.what || t("agent.runNoText")}</b>
                          <span className="agp-chips">
                            <RunChip run={r} />
                            <Chip icon={x.where.startsWith("#") ? "channel" : "person"}>
                              {x.where.replace(/^#/, "")}
                            </Chip>
                            {x.routine && <Chip icon="routines">{t("agentPage.activity.routine")}</Chip>}
                          </span>
                          {r.status === "failed" && (
                            <span className="agp-run__fail">
                              <Icon name="alert" size={14} />
                              {failure(t, r)}
                            </span>
                          )}
                        </span>
                        <span className="agp-run__r">
                          {t("agent.runTokens", { tokens: formatInt(locale, r.inputTokens + r.outputTokens) })}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
        <div className="agp-row agp-row--between">
          <span className="small muted">
            {t("agentPage.activity.showing", { shown: visible.length, total: filtered.length })}
          </span>
          {filtered.length > visible.length && (
            <Button size="sm" onClick={() => setShown((n) => n + RUNS_PAGE)}>
              {t("agentPage.activity.more")}
            </Button>
          )}
        </div>
      </Card>
    </>
  );
}
