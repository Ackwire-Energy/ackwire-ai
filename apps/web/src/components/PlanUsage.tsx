import type { OrgPlanUsage, PlanAccountInfo, PlanAccountUsage } from "@agenteschat/client";
import { useApi, usePlanUsage } from "@agenteschat/client";
import { formatPercent, formatTokensShort, formatUsd } from "@agenteschat/client/lib/format";
import { planName } from "@agenteschat/client/lib/plans";
import { Card, CardHeader, Icon, Meter, PlanMeter, ProviderLogo } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { accountName, brandOf, noWindowsText, partedUsage, planMeterText } from "@/lib/plan-usage";
import "./plan-usage.css";

/*
 * The usage views (ADR 0063): an account's head, shared with the agent's
 * "Uso" tab, and Configurações › Uso: the plan accounts by computer, each
 * window with every agent's estimated part, then the API per agent. Money
 * only where the server sent it (`view_usage`).
 */

/** An account's head: the maker's mark, its name and plan, its maker and whose it is. */
export function AccountHead({ account, extra }: { account: PlanAccountInfo; extra?: string | null }) {
  const { t } = useTranslation();
  const whose =
    account.email ?? (account.ownerName ? t("usageViews.whose", { name: account.ownerName.split(" ")[0] }) : null);
  return (
    <div className="plan-acct ac-faceline">
      <ProviderLogo id={account.provider ?? account.kind} size="sm" off={account.signedOut} />
      <span className="plan-acct__text">
        <span className="plan-acct__name ac-captop">
          {accountName(t, account)}
          {account.plan && <span className="plan-acct__chip">{planName(account.plan)}</span>}
          {account.signedOut && (
            <span className="plan-acct__chip plan-acct__chip--out">{t("usageViews.signedOut")}</span>
          )}
        </span>
        <span className="plan-acct__sub">{[brandOf(account), whose, extra].filter(Boolean).join(" · ")}</span>
      </span>
    </div>
  );
}

/** Configurações › Uso for everyone: the plan accounts by computer, then the API per agent. */
export function PlanUsageCards() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const usage = usePlanUsage(org.id);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  if (usage.isLoading) {
    return (
      <Card>
        <LoadingList count={3} avatar={false} trailing />
      </Card>
    );
  }
  if (!usage.data) {
    return (
      <Card>
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
      </Card>
    );
  }
  const data = usage.data;
  const machines = new Map<string, PlanAccountUsage[]>();
  for (const a of data.accounts) machines.set(a.machineId, [...(machines.get(a.machineId) ?? []), a]);
  return (
    <>
      <Card aria-labelledby="sec-usage-plans">
        <CardHeader
          id="sec-usage-plans"
          icon="computer"
          title={t("usageViews.accounts.title")}
          hint={{ name: t("common.about", { label: t("usageViews.accounts.title") }), text: t("usageViews.estimate") }}
        />
        {data.accounts.length === 0 ? (
          <p className="plan-empty">{t("usageViews.accounts.empty")}</p>
        ) : (
          <div className="plan-machines">
            {[...machines].map(([machineId, list]) => (
              <div key={machineId} className="plan-machine">
                <div className="plan-machine__name">
                  <Icon name="computer" size={14} />
                  {list[0]?.machineName}
                </div>
                {list.map((a) => (
                  <AccountBlock key={a.key} account={a} money={data.money} />
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>
      <ApiCard data={data} />
    </>
  );
}

function AccountBlock({ account, money }: { account: PlanAccountUsage; money: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const nameOf = (a: { agentId: string; name: string }) => dir.agentById.get(a.agentId)?.name ?? a.name;
  return (
    <div className="plan-block">
      <AccountHead account={account} />
      {account.usage ? (
        <PlanMeter
          usage={partedUsage(account.usage, (parts) =>
            parts
              .map((p) => t("usageViews.part", { name: nameOf(p), percent: formatPercent(i18n.language, p.percent) }))
              .join(" · "),
          )}
          text={planMeterText(t, i18n.language)}
        />
      ) : (
        <p className="plan-empty">{noWindowsText(t, account)}</p>
      )}
      {account.agents.length > 0 && (
        <div className="plan-block__foot">
          <span className="plan-legend">
            {account.agents.map((a) => (
              <Link
                key={a.agentId}
                className="plan-legend__agent"
                to="/org/$orgId/agents/$agentId"
                params={{ orgId: org.id, agentId: a.agentId }}
                search={{ tab: "usage" }}
              >
                <AgentAvatar agentId={a.agentId} size="xs" name={nameOf(a)} />
                <b>{nameOf(a)}</b>
                {a.tokens > 0 ? formatTokensShort(t, i18n.language, a.tokens) : t("usageViews.usesNow")}
              </Link>
            ))}
          </span>
          <span className="plan-block__month">
            {t("usageViews.monthTokens", { tokens: formatTokensShort(t, i18n.language, account.monthTokens) })}
            {money && typeof account.equivalentUsd === "number" && (
              <> · {t("usageViews.equivalent", { amount: formatUsd(t, i18n.language, account.equivalentUsd) })}</>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function ApiCard({ data }: { data: OrgPlanUsage }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (data.api.length === 0) return null;
  return (
    <Card aria-labelledby="sec-usage-api">
      <CardHeader id="sec-usage-api" icon="key" title={t("usageViews.api.title")} />
      <div className="plan-api">
        {data.api.map((a) => {
          const name = dir.agentById.get(a.agentId)?.name ?? a.name;
          return (
            <Link
              key={a.agentId}
              className="plan-api__row"
              to="/org/$orgId/agents/$agentId"
              params={{ orgId: org.id, agentId: a.agentId }}
              search={{ tab: "usage" }}
            >
              <AgentAvatar agentId={a.agentId} size="sm" name={name} />
              <span className="plan-api__name">
                <b>{name}</b>
                <small>{t("usageViews.tokens", { tokens: formatTokensShort(t, i18n.language, a.tokens) })}</small>
              </span>
              <span className="plan-api__meter">
                <Meter
                  value={Math.min(100, a.budgetPercent)}
                  max={100}
                  label={t("settings.usageAgentMeter", { name })}
                />
              </span>
              <span className="plan-api__value">
                {t("usageViews.budgetShare", { percent: formatPercent(i18n.language, a.budgetPercent) })}
                {a.costUsd !== undefined && a.budgetUsd !== undefined && (
                  <small>
                    {t(a.budgetIsDefault ? "settings.usageAgentLineDefault" : "settings.usageAgentLine", {
                      spent: formatUsd(t, i18n.language, a.costUsd),
                      budget: formatUsd(t, i18n.language, a.budgetUsd),
                    })}
                  </small>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
