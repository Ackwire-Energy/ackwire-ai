import type { OrgPlanUsage, PlanAccountInfo, PlanAccountUsage } from "@agenteschat/client";
import { useApi, useModels, usePlanUsage } from "@agenteschat/client";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { formatPercent, formatTokensShort, formatUsd } from "@agenteschat/client/lib/format";
import { planName } from "@agenteschat/client/lib/plans";
import { AUTO, apiProviderOf } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  agentGradient,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  InfoHint,
  Meter,
  PlanMeter,
  ProviderLogo,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { PlanHold, usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi, useMayConnectAi } from "@/components/ConnectAi";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { accountName, accountShares, brandOf, noWindowsText, planMeterText, splitUsage } from "@/lib/plan-usage";
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
    <div className="plan-acct ac-mediarow ac-mediarow--row">
      <span className="ac-mediarow__face">
        <ProviderLogo id={account.provider ?? account.kind} size="sm" off={account.signedOut} />
      </span>
      <span className="ac-mediarow__head">
        <span className="plan-acct__name">
          {accountName(t, account)}
          {account.plan && <span className="plan-acct__chip">{planName(account.plan)}</span>}
          {account.signedOut && (
            <span className="plan-acct__chip plan-acct__chip--out">{t("usageViews.signedOut")}</span>
          )}
        </span>
      </span>
      <span className="ac-mediarow__body plan-acct__sub">
        {[brandOf(account), whose, extra].filter(Boolean).join(" · ")}
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
  const look = useRightHandLook();
  const connectAi = useConnectAi();
  const mayConnect = useMayConnectAi();
  const hold = usePlanHold();
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
        {data.accounts.length === 0 && hold ? (
          // What comes first, as in Contas de IA: an invitation to connect a plan would contradict it.
          <PlanHold hold={hold} />
        ) : data.accounts.length === 0 ? (
          <EmptyState
            size="panel"
            agent={look}
            title={t("aiAccounts.page.emptyTitle")}
            actions={
              connectAi &&
              mayConnect && (
                <Button variant="primary" icon="plus" onClick={() => connectAi.open({})}>
                  {t("aiAccounts.page.connect")}
                </Button>
              )
            }
          >
            {t(mayConnect ? "usageViews.accounts.empty" : "aiAccounts.page.emptyViewer")}
          </EmptyState>
        ) : (
          <div className="plan-machines">
            {[...machines].map(([machineId, list]) => (
              <div key={machineId} className="plan-machine">
                <div className="plan-machine__name">
                  <Icon name="computer" size={14} />
                  {computerNameOf(t, org.name, list[0]?.machineName ?? "", isPersonal(org))}
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

/**
 * A plan account: its bars split by agent in their colours, then one list of its agents (share of the window the bar
 * splits, tokens this month), when it renews and how old the numbers are, and the month's total.
 */
function AccountBlock({ account, money }: { account: PlanAccountUsage; money: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const text = planMeterText(t, i18n.language);
  const shares = accountShares(account);
  const list = shares.shown.length > 0 && (
    <AgentShares shares={shares} window={shares.window ? text.window(shares.window) : null} />
  );
  return (
    <div className="plan-block">
      <AccountHead account={account} />
      {account.usage ? (
        <PlanMeter usage={splitUsage(account.usage, (id) => agentGradient(colorOf(dir.agentById.get(id))))} text={text}>
          {list}
        </PlanMeter>
      ) : (
        <>
          <p className="plan-empty">{noWindowsText(t, account)}</p>
          {list}
        </>
      )}
      {account.agents.length > 0 && (
        <span className="plan-block__month">
          {t("usageViews.monthTokens", { tokens: formatTokensShort(t, i18n.language, account.monthTokens) })}
          {money && typeof account.equivalentUsd === "number" && (
            <>
              {" · "}
              <span className="ac-hintline">
                <span>{t("usageViews.equivalent", { amount: formatUsd(i18n.language, account.equivalentUsd) })}</span>
                <InfoHint name={t("common.about", { label: t("usageViews.apiPrice") })}>
                  {t("usageViews.apiPriceHint")}
                </InfoHint>
              </span>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/** The account's agents, biggest share first; past the first few, one row that opens the rest in place. */
function AgentShares({ shares, window }: { shares: ReturnType<typeof accountShares>; window: string | null }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  const percent = (share: number) => (window ? formatPercent(i18n.language, share) : "");
  const tokens = (n: number, now = false) =>
    n > 0 ? formatTokensShort(t, i18n.language, n) : now ? t("usageViews.usesNow") : "";
  return (
    <div className="plan-shares">
      <div className="plan-shares__head">
        <span />
        <span />
        <span>{window}</span>
        <span>{t("usageViews.thisMonth")}</span>
      </div>
      {(open ? [...shares.shown, ...shares.rest] : shares.shown).map((a) => {
        const name = dir.agentById.get(a.agentId)?.name ?? a.name;
        return (
          <Link
            key={a.agentId}
            className="plan-shares__row"
            to="/org/$orgId/agents/$agentId"
            params={{ orgId: org.id, agentId: a.agentId }}
            search={{ tab: "usage" }}
          >
            <AgentAvatar agentId={a.agentId} size="xs" name={name} />
            <b>{name}</b>
            <span>{percent(a.share)}</span>
            <span>{tokens(a.tokens, a.now)}</span>
          </Link>
        );
      })}
      {!open && shares.rest.length > 0 && (
        <button type="button" className="plan-shares__row" aria-expanded={false} onClick={() => setOpen(true)}>
          <span />
          <b>{t("usageViews.moreAgents", { count: shares.rest.length })}</b>
          <span>{percent(shares.restShare)}</span>
          <span>{tokens(shares.restTokens)}</span>
        </button>
      )}
    </div>
  );
}

/** "US$ 0,32 de US$ 50,00 (padrão do workspace)": the closing "(…)" wraps as one piece, not split across lines. */
function noteWhole(text: string) {
  const m = /^(.*\S)\s+(\(.+\))$/.exec(text);
  if (!m) return text;
  return (
    <>
      {m[1]} <span className="plan-api__note">{m[2]}</span>
    </>
  );
}

function ApiCard({ data }: { data: OrgPlanUsage }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const provider = apiProviderOf(AUTO, useModels().data?.models ?? []);
  if (data.api.length === 0) return null;
  return (
    <Card aria-labelledby="sec-usage-api">
      <CardHeader id="sec-usage-api" icon="key" mark={provider} title={t("usageViews.api.title")} />
      <div className="plan-api">
        {data.api.map((a) => {
          const name = dir.agentById.get(a.agentId)?.name ?? a.name;
          // The server's percent has one decimal, so a tiny spend comes as 0: the money, when sent, is exact.
          const percent = a.costUsd !== undefined && a.budgetUsd ? (a.costUsd / a.budgetUsd) * 100 : a.budgetPercent;
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
                <Meter value={Math.min(100, percent)} max={100} label={t("settings.usageAgentMeter", { name })} />
              </span>
              <span className="plan-api__value">
                {t("usageViews.budgetShare", { percent: formatPercent(i18n.language, percent) })}
                {a.costUsd !== undefined && a.budgetUsd !== undefined && (
                  <small>
                    {noteWhole(
                      t(a.budgetIsDefault ? "settings.usageAgentLineDefault" : "settings.usageAgentLine", {
                        spent: formatUsd(i18n.language, a.costUsd),
                        budget: formatUsd(i18n.language, a.budgetUsd),
                      }),
                    )}
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
