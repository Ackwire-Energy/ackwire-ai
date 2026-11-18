import type { PlanAccountUsage, PlanServes, PlanUseKind } from "@agenteschat/client";
import { keys, useAiAccounts, useApi, usePlanUsage } from "@agenteschat/client";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { formatTokensShort, formatUsd } from "@agenteschat/client/lib/format";
import {
  accountKinds,
  accountName,
  accountShares,
  brandOf,
  groupUsageAccounts,
  kindFacts,
  noWindowsText,
  planMeterText,
  servesTerms,
  shareFacts,
  splitUsage,
} from "@agenteschat/client/lib/plan-usage";
import { planName } from "@agenteschat/client/lib/plans";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { gradientOf } from "@agenteschat/ui/agent/engine";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { GROUPED_ROW, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SkeletonList, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useOpenDm } from "../new/useOpenDm";
import { AgentFace } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useErrorToast, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader } from "../shared/parts";
import { PlanMeter, PlanModels } from "./parts";

/*
 * A plan account's usage, pushed from its row on Uso (ADR 0063), as the web's open `AccountRow`: its maker, address and
 * computer, every window with its bar split by agent in their colours and when it renews, its quotas per model, the
 * month's tokens, each agent with its part (a row to that agent's usage), what the use was for (the web's
 * `KindShares`), and, for whoever connected it, who uses it (ADR 0059 §3) and the way to the AI accounts screen where
 * they rename it, sign in again or disconnect it.
 */

/** Opens an account of Uso by its row's key (one person's logins of one account are one row). */
export const openUsageAccount = (key: string) => router.push(`/usage-account?key=${encodeURIComponent(key)}` as never);

export function UsageAccountScreen({ accountKey }: { accountKey: string }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const api = useApi();
  const usage = usePlanUsage(orgId);
  const mine = useAiAccounts(orgId);
  // A pull asks the plans for their usage again and reads the account's windows again.
  const pull = usePullRefresh(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
    return Promise.allSettled([usage.refetch(), mine.refetch()]);
  });
  const accounts = usage.data ? groupUsageAccounts(usage.data.accounts, mine.data) : [];
  const account = accounts.find((a) => a.key === accountKey);
  const several = new Set(accounts.map((a) => a.machineId)).size > 1;
  const subtitle = [
    account?.plan ? planName(account.plan) : null,
    account?.signedOut ? t("usageViews.signedOut") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={account ? accountName(t, account) : t("settings.section.usage")}
        {...(subtitle ? { subtitle } : {})}
        solid={false}
        grouped
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        {usage.isLoading ? (
          <SkeletonList rows={3} />
        ) : !account ? (
          <LoadFailed onRetry={() => void usage.refetch()} />
        ) : (
          <Detail account={account} money={usage.data?.money === true} several={several} />
        )}
      </ScrollView>
    </View>
  );
}

function Detail({ account, money, several }: { account: PlanAccountUsage; money: boolean; several: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory();
  const text = planMeterText(t, i18n.language);
  const shares = accountShares(account);
  const window = shares.window ? text.short(shares.window) : null;
  const computer = several ? computerNameOf(t, org?.name ?? "", account.machineName, isPersonal(org)) : null;
  const tokens = t("usageViews.monthTokens", { tokens: formatTokensShort(t, i18n.language, account.monthTokens) });
  const priced = money && typeof account.equivalentUsd === "number";
  // Every agent, biggest share first: the screen is the list, nothing left folded.
  const agents = [...shares.shown, ...shares.rest];
  return (
    <>
      <GroupedFooter>{[brandOf(account), account.email, computer].filter(Boolean).join(" · ")}</GroupedFooter>
      <GroupedHeader
        {...(account.usage
          ? { hint: { name: t("common.about", { label: t("agentPage.tabs.usage") }), text: t("usageViews.estimate") } }
          : {})}
      >
        {t("agentPage.tabs.usage")}
      </GroupedHeader>
      <GroupedList>
        <View style={styles.meter}>
          {account.usage ? (
            <>
              <PlanMeter
                plain
                usage={splitUsage(account.usage, (id) => gradientOf(agentLook(dir.agentById.get(id)).color))}
              />
              <PlanModels usage={account.usage} provider={account.provider} />
            </>
          ) : (
            <Text variant="footnote" tone="muted">
              {noWindowsText(t, account)}
            </Text>
          )}
        </View>
      </GroupedList>
      {account.monthTokens > 0 ? (
        priced ? (
          <GroupedFooter
            hint={{ name: t("common.about", { label: t("usageViews.apiPrice") }), text: t("usageViews.apiPriceHint") }}
          >
            {`${tokens} · ${t("usageViews.equivalent", { amount: formatUsd(i18n.language, account.equivalentUsd ?? 0) })}`}
          </GroupedFooter>
        ) : (
          <GroupedFooter>{tokens}</GroupedFooter>
        )
      ) : null}
      {agents.length > 0 ? (
        <>
          <GroupedHeader>{t("shell.agents")}</GroupedHeader>
          <GroupedList>
            {agents.map((a) => (
              <GroupedRow
                key={a.agentId}
                leading={<AgentFace agentId={a.agentId} size={GROUPED_ROW.lead} live={false} />}
                label={dir.agentById.get(a.agentId)?.name ?? a.name}
                sub={shareFacts(t, i18n.language, window, a).replace(/^ · /, "")}
                chevron
                onPress={() => router.push(`/agent-usage/${a.agentId}` as never)}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
      <Kinds account={account} window={window} />
      {account.mine && account.accountId && account.serves ? (
        <WhoUses accountId={account.accountId} account={account} />
      ) : null}
      {account.mine && account.accountId ? (
        <>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow icon="brain" label={t("mobile.ai.row")} chevron onPress={() => router.push("/ai-accounts")} />
          </GroupedList>
        </>
      ) : null}
    </>
  );
}

// The web's swap, person and routines; a routine is a clock on the phone (`intent.ts`).
const KIND_ICONS = { handoffs: "swap", people: "person", routines: "clock" } as const satisfies Record<
  PlanUseKind,
  string
>;

/**
 * Under the agents, what the account's use was for, in the shared order with each fact whole; when handoffs led the
 * week, why to ask the agent directly and a row that opens the DM with the agent that took most of it, ready to type:
 * the web's `KindShares`.
 */
function Kinds({ account, window }: { account: PlanAccountUsage; window: string | null }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const openDm = useOpenDm();
  const kinds = accountKinds(account);
  const target = account.hint ? dir.agentById.get(account.hint.agentId) : undefined;
  if (kinds.length === 0) return null;
  return (
    <>
      <GroupedHeader>{t("usage.kinds.label")}</GroupedHeader>
      <GroupedList>
        {kinds.map((k) => (
          <GroupedRow
            key={k.kind}
            icon={KIND_ICONS[k.kind]}
            label={t(`usage.kinds.${k.kind}`)}
            sub={kindFacts(t, i18n.language, window, k).replace(/^ · /, "")}
          />
        ))}
      </GroupedList>
      {target ? (
        <>
          <GroupedFooter>{t("usage.hint.handoffs")}</GroupedFooter>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow
              icon="chat"
              label={t("usage.hint.message", { name: target.name })}
              chevron
              onPress={() => void openDm({ agentId: target.id }, { compose: true })}
            />
          </GroupedList>
        </>
      ) : null}
    </>
  );
}

/**
 * "Quem usa" (ADR 0059 §3), for whoever connected the plan, as on the web: two choices, the one in force checked, saved
 * at once; its terms behind the header's ⓘ.
 */
function WhoUses({ accountId, account }: { accountId: string; account: PlanAccountUsage }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const failed = useErrorToast();
  const [busy, setBusy] = useState<PlanServes | null>(null);
  const saved = account.serves ?? "everyone";
  // The choice moves on the tap; a refusal puts it back.
  const serves = busy ?? saved;
  const terms = servesTerms(t, account);
  const choose = async (next: PlanServes) => {
    if (next === serves || busy) return;
    setBusy(next);
    try {
      await api.machines.setAccountServes(orgId, accountId, next);
      toast({
        title: t(next === "owner" ? "usageViews.serves.savedOwner" : "usageViews.serves.savedEveryone"),
        icon: "check",
      });
      for (const key of [keys.planUsage(orgId), keys.aiAccounts(orgId), keys.agents(orgId), keys.aiStatus(orgId)])
        await qc.invalidateQueries({ queryKey: key });
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <GroupedHeader hint={{ name: t("common.about", { label: t("aiAccounts.share.terms.about") }), text: terms.text }}>
        {t("usageViews.serves.label")}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="members"
          label={t("usageViews.serves.all")}
          checked={serves === "everyone"}
          onPress={() => void choose("everyone")}
        />
        <GroupedRow
          icon="person"
          label={t("usageViews.serves.me")}
          checked={serves === "owner"}
          onPress={() => void choose("owner")}
        />
      </GroupedList>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  // The bars in a grouped row, on its edges.
  meter: { paddingHorizontal: GROUPED_ROW.padX, paddingVertical: 12, gap: 10 },
  // A list without a header: the room of one above it.
  gap: { height: 14 },
});
