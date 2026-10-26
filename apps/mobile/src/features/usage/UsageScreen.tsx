import type { OrgPlanUsage, PlanAccountUsage } from "@agenteschat/client";
import { useApi, usePlanUsage, useSettings, useUpdateSettings, useUsageReport } from "@agenteschat/client";
import { formatPercent, formatShortDate, formatTokensShort, formatUsd } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { noWindowsText, partedUsage } from "@agenteschat/client/lib/plan-usage";
import { parseAmount } from "@agenteschat/client/lib/text";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, fieldText, Icon, Text, useTheme, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { AccountHead, PlanMeter, UsageCard } from "./parts";

/*
 * Uso, as the web's Configurações › Uso (ADR 0063): the plan accounts by computer, each window with every agent's
 * estimated part, then the API per agent; for who sees money (`view_usage`), the API spend by kind. Money only where
 * the server sent it.
 */

export const openAgentUsage = (agentId: string) => router.push(`/agent-usage/${agentId}` as never);

export function UsageScreen() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const api = useApi();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const usage = usePlanUsage(orgId);
  const allowed = can(org?.role, "view_usage");
  const report = useUsageReport(orgId, allowed);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);
  const data = usage.data;
  const machines = new Map<string, PlanAccountUsage[]>();
  for (const a of data?.accounts ?? []) machines.set(a.machineId, [...(machines.get(a.machineId) ?? []), a]);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("mobile.me.usage")} solid={false} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        {usage.isLoading ? <ActivityIndicator color={c.muted} /> : null}
        {!usage.isLoading && !data ? (
          <Text variant="small" tone="muted">
            {t("common.loadFailed")}
          </Text>
        ) : null}
        {data ? (
          <>
            <UsageCard
              icon="laptop"
              title={t("usageViews.accounts.title")}
              subtitle={t("usageViews.accounts.subtitle")}
              footer={data.accounts.length > 0 ? t("usageViews.estimate") : undefined}
            >
              {data.accounts.length === 0 ? (
                <Text variant="small" tone="muted">
                  {t("usageViews.accounts.empty")}
                </Text>
              ) : (
                [...machines].map(([machineId, list]) => (
                  <View key={machineId} style={styles.machine}>
                    <View style={styles.machineName}>
                      <Icon name="laptop" size={14} color={c.faint} />
                      <Text variant="caption" tone="faint" style={styles.caps}>
                        {list[0]?.machineName.toLocaleUpperCase()}
                      </Text>
                    </View>
                    {list.map((a, i) => (
                      <View
                        key={a.key}
                        style={i > 0 ? [styles.block, styles.divided, { borderTopColor: c.line }] : styles.block}
                      >
                        <AccountBlock account={a} money={data.money} />
                      </View>
                    ))}
                  </View>
                ))
              )}
            </UsageCard>
            <ApiCard data={data} />
          </>
        ) : null}
        {allowed && report.data ? (
          <UsageCard icon="chart" title={t("settings.usageTitle")}>
            <Text variant="small" tone="muted">
              {t("settings.usageTotal", {
                amount: formatUsd(t, i18n.language, report.data.totalUsd),
                since: formatShortDate(i18n.language, report.data.since),
              })}
            </Text>
            <View>
              {report.data.byKind.map((k, i) => (
                <View
                  key={k.kind}
                  style={[styles.kind, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
                >
                  <Text variant="subhead" tone="ink" style={styles.grow}>
                    {t(`settings.kinds.${k.kind}`)}
                  </Text>
                  <Text variant="small" tone="muted" style={styles.tabular}>
                    {t("settings.usageCalls", { count: k.calls })}
                  </Text>
                  <Text variant="subhead" tone="ink2" style={[styles.tabular, styles.amount]}>
                    {formatUsd(t, i18n.language, k.costUsd)}
                  </Text>
                </View>
              ))}
            </View>
          </UsageCard>
        ) : null}
        {allowed ? <DefaultBudgetCard /> : null}
      </ScrollView>
    </View>
  );
}

function AccountBlock({ account, money }: { account: PlanAccountUsage; money: boolean }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const nameOf = (a: { agentId: string; name: string }) => dir.agentById.get(a.agentId)?.name ?? a.name;
  return (
    <>
      <AccountHead account={account} />
      {account.usage ? (
        <PlanMeter
          usage={partedUsage(account.usage, (parts) =>
            parts
              .map((p) => t("usageViews.part", { name: nameOf(p), percent: formatPercent(i18n.language, p.percent) }))
              .join(" · "),
          )}
        />
      ) : (
        <Text variant="small" tone="muted">
          {noWindowsText(t, account)}
        </Text>
      )}
      {account.agents.length > 0 ? (
        <View style={styles.foot}>
          <View style={styles.legend}>
            {account.agents.map((a) => (
              <Pressable
                key={a.agentId}
                onPress={() => openAgentUsage(a.agentId)}
                accessibilityRole="button"
                style={styles.legendAgent}
              >
                <AgentFace agentId={a.agentId} size={18} live={false} />
                <Text variant="small" tone="ink" style={styles.bold}>
                  {nameOf(a)}
                </Text>
                <Text variant="small" tone="muted">
                  {a.tokens > 0 ? formatTokensShort(t, i18n.language, a.tokens) : t("usageViews.usesNow")}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text variant="small" tone="muted">
            {t("usageViews.monthTokens", { tokens: formatTokensShort(t, i18n.language, account.monthTokens) })}
            {money && typeof account.equivalentUsd === "number"
              ? ` · ${t("usageViews.equivalent", { amount: formatUsd(t, i18n.language, account.equivalentUsd) })}`
              : ""}
          </Text>
        </View>
      ) : null}
    </>
  );
}

/** The API per agent: its tokens, its share of its budget and (with money) what it spent of it. */
function ApiCard({ data }: { data: OrgPlanUsage }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  if (data.api.length === 0) return null;
  return (
    <UsageCard icon="lock" title={t("usageViews.api.title")} subtitle={t("usageViews.api.subtitle")}>
      <View>
        {data.api.map((a, i) => {
          const name = dir.agentById.get(a.agentId)?.name ?? a.name;
          return (
            <Pressable
              key={a.agentId}
              onPress={() => openAgentUsage(a.agentId)}
              accessibilityRole="button"
              style={[styles.api, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
            >
              <AgentFace agentId={a.agentId} size={28} live={false} />
              <View style={styles.grow}>
                <Text variant="subhead" tone="ink" numberOfLines={1} style={styles.bold}>
                  {name}
                </Text>
                <Text variant="small" tone="muted" style={styles.tabular}>
                  {`${t("usageViews.tokens", { tokens: formatTokensShort(t, i18n.language, a.tokens) })} · ${t("usageViews.budgetShare", { percent: formatPercent(i18n.language, a.budgetPercent) })}`}
                </Text>
                {a.costUsd !== undefined && a.budgetUsd !== undefined ? (
                  <Text variant="small" tone="muted" style={styles.tabular}>
                    {t(a.budgetIsDefault ? "settings.usageAgentLineDefault" : "settings.usageAgentLine", {
                      spent: formatUsd(t, i18n.language, a.costUsd),
                      budget: formatUsd(t, i18n.language, a.budgetUsd),
                    })}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </UsageCard>
  );
}

/** The budget of every agent without its own (the web's card); members only ever see percentages of it. */
function DefaultBudgetCard() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const settings = useSettings(orgId);
  const update = useUpdateSettings(orgId);
  const toast = useToast();
  const { colors: c, shadows } = useTheme();
  const editable = can(org?.role, "configure");
  const saved = settings.data?.defaultAgentBudgetUsd;
  const [value, setValue] = useState("");
  useEffect(() => {
    if (saved !== undefined) setValue(new Intl.NumberFormat(i18n.language).format(saved));
  }, [saved, i18n.language]);
  const amount = parseAmount(value);
  const invalid = value.trim() !== "" && !(amount > 0);
  const dirty = saved !== undefined && amount > 0 && amount !== saved;
  return (
    <UsageCard icon="lock" title={t("settings.defaultBudgetTitle")}>
      <View style={styles.budget}>
        <Text variant="small" tone="ink2" style={styles.bold}>
          {t("settings.defaultBudget")}
        </Text>
        <TextInput
          value={value}
          onChangeText={setValue}
          keyboardType="decimal-pad"
          editable={editable && saved !== undefined}
          accessibilityLabel={t("settings.defaultBudget")}
          style={[styles.input, { color: c.ink, backgroundColor: c.bg, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
        />
        <Text variant="small" tone={invalid ? "danger" : "muted"}>
          {invalid ? t("agent.budgetInvalid") : t("settings.defaultBudgetHelp")}
        </Text>
        {editable ? (
          <View style={styles.start}>
            <Button
              size="sm"
              variant="primary"
              label={t("common.save")}
              disabled={!dirty || update.isPending}
              onPress={() =>
                update.mutate(
                  { defaultAgentBudgetUsd: amount },
                  { onSuccess: () => toast({ title: t("settings.defaultBudgetSaved"), icon: "check" }) },
                )
              }
            />
          </View>
        ) : null}
      </View>
    </UsageCard>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8, gap: 14 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  caps: { fontWeight: "700", letterSpacing: 0.5 },
  tabular: { fontVariant: ["tabular-nums"] },
  machine: { gap: 2 },
  machineName: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 2 },
  block: { gap: 12, paddingVertical: 14 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth },
  foot: { gap: 8 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 6, columnGap: 14 },
  legendAgent: { flexDirection: "row", alignItems: "center", gap: 6 },
  // Narrower than the web's row: the tokens and the budget's share on one line under the name, the spend under it.
  api: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  kind: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  amount: { minWidth: 64, textAlign: "right" },
  budget: { gap: 6 },
  input: { minHeight: 46, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 10, ...fieldText("body") },
  start: { alignSelf: "flex-start", marginTop: 4 },
});
