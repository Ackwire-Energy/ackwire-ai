import type { OrgPlanUsage, PlanAccountUsage } from "@agenteschat/client";
import {
  useApi,
  useComposioUsage,
  usePlanUsage,
  useSettings,
  useUpdateSettings,
  useUsageReport,
} from "@agenteschat/client";
import { composioUsageText, showsComposioUsage } from "@agenteschat/client/lib/composio";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { formatPercent, formatShortDate, formatTokensShort, formatUsd } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { accountShares, noWindowsText, planMeterText, splitUsage } from "@agenteschat/client/lib/plan-usage";
import { parseAmount } from "@agenteschat/client/lib/text";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { gradientOf } from "@agenteschat/ui/agent/engine";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, fieldText, Icon, InfoHint, MEDIA_ROW, MediaRow, Segmented, Text, useTheme, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { PlanHoldNote, usePlanHold } from "../ai/parts";
import { AgentFace } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Loaded, PushedHeader } from "../shared/parts";
import { AccountHead, PlanMeter, UsageCard } from "./parts";
import { MyUsageCard, PeopleList } from "./people";

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
  const hold = usePlanHold(orgId, org);
  const allowed = can(org, "view_usage");
  const report = useUsageReport(orgId, allowed);
  // Calls, not money: every member sees them (ADR 0107 §7).
  const composio = useComposioUsage(orgId);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);
  // Uso › Pessoas (ADR 0141): each person's month for who sees money, else one's own.
  const [view, setView] = useState<"summary" | "people">("summary");
  const data = usage.data;
  const machines = new Map<string, PlanAccountUsage[]>();
  for (const a of data?.accounts ?? []) machines.set(a.machineId, [...(machines.get(a.machineId) ?? []), a]);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("mobile.me.usage")} solid={false} grouped />
      {/* The default budget's field: Salvar takes the first tap, and the field stays above the keyboard. */}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <Segmented
          value={view}
          onChange={(v) => setView(v === "people" ? "people" : "summary")}
          items={[
            { key: "summary", label: t("peopleUsage.tabs.summary") },
            { key: "people", label: allowed ? t("peopleUsage.tabs.people") : t("peopleUsage.tabs.mine") },
          ]}
        />
        {/* A view switched to, or numbers that came in, fade in; what is here when the screen opens just shows. */}
        <LayoutAnimationConfig skipEntering>
          {view === "people" ? <Loaded>{allowed ? <PeopleList /> : <MyUsageCard />}</Loaded> : null}
          {view === "people" ? null : usage.isLoading ? <ActivityIndicator color={c.muted} /> : null}
          {view === "people" ? null : !usage.isLoading && !data ? (
            <Text variant="small" tone="muted">
              {t("common.loadFailed")}
            </Text>
          ) : null}
          {data && view === "summary" ? (
            <Loaded>
              <View style={styles.stack}>
                <UsageCard
                  icon="laptop"
                  title={t("usageViews.accounts.title")}
                  {...(data.accounts.length > 0
                    ? {
                        hint: {
                          name: t("common.about", { label: t("usageViews.accounts.title") }),
                          text: t("usageViews.estimate"),
                        },
                      }
                    : {})}
                >
                  {data.accounts.length === 0 && hold ? (
                    <PlanHoldNote org={org} />
                  ) : data.accounts.length === 0 ? (
                    <FirstUse
                      place="ai"
                      size="inline"
                      acts
                      label={t("aiAccounts.page.connect")}
                      onPress={() => router.push("/ai-accounts")}
                    />
                  ) : (
                    [...machines].map(([machineId, list]) => (
                      <View key={machineId} style={styles.machine}>
                        <View style={styles.machineName}>
                          <Icon name="laptop" size={12} color={c.faint} />
                          <Text variant="caption" tone="faint" style={[styles.caps, styles.shrink]}>
                            {computerNameOf(
                              t,
                              org?.name ?? "",
                              list[0]?.machineName ?? "",
                              isPersonal(org),
                            ).toLocaleUpperCase()}
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
              </View>
            </Loaded>
          ) : null}
          {view === "summary" && composio.data && showsComposioUsage(composio.data) ? (
            <UsageCard icon="chart" title={composioUsageText(t, i18n.language, composio.data)}>
              {null}
            </UsageCard>
          ) : null}
          {view === "summary" && allowed && report.data ? (
            <UsageCard icon="chart" title={t("settings.usageTitle")}>
              <Text variant="small" tone="muted">
                {t("settings.usageTotal", {
                  amount: formatUsd(i18n.language, report.data.totalUsd),
                  since: formatShortDate(i18n.language, report.data.since),
                })}
              </Text>
              <View>
                {report.data.byKind.map((k, i) => (
                  <View
                    key={k.kind}
                    style={[styles.kind, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
                  >
                    <Text variant="subhead" tone="ink" numberOfLines={1} style={styles.grow}>
                      {t(`settings.kinds.${k.kind}`)}
                    </Text>
                    <Text variant="small" tone="muted" style={styles.tabular}>
                      {t("settings.usageCalls", { count: k.calls })}
                    </Text>
                    <Text variant="subhead" tone="ink2" style={[styles.tabular, styles.amount]}>
                      {formatUsd(i18n.language, k.costUsd)}
                    </Text>
                  </View>
                ))}
              </View>
            </UsageCard>
          ) : null}
          {view === "summary" && allowed ? <DefaultBudgetCard /> : null}
        </LayoutAnimationConfig>
      </ScrollView>
    </View>
  );
}

/**
 * A plan account (the web's `AccountBlock`): its bars split by agent in their colours, then one list of its agents,
 * when it renews and how old the numbers are, and the month's total.
 */
function AccountBlock({ account, money }: { account: PlanAccountUsage; money: boolean }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const shares = accountShares(account);
  const list =
    shares.shown.length > 0 ? (
      <AgentShares
        shares={shares}
        window={shares.window ? planMeterText(t, i18n.language).window(shares.window) : null}
      />
    ) : null;
  return (
    <>
      <AccountHead account={account} />
      {account.usage ? (
        <PlanMeter usage={splitUsage(account.usage, (id) => gradientOf(agentLook(dir.agentById.get(id)).color))}>
          {list}
        </PlanMeter>
      ) : (
        <>
          <Text variant="small" tone="muted">
            {noWindowsText(t, account)}
          </Text>
          {list}
        </>
      )}
      {account.agents.length > 0 ? (
        money && typeof account.equivalentUsd === "number" ? (
          <InfoHint
            name={t("common.about", { label: t("usageViews.apiPrice") })}
            text={t("usageViews.apiPriceHint")}
            variant="small"
          >
            <Text variant="small" tone="muted">
              {t("usageViews.monthTokens", { tokens: formatTokensShort(t, i18n.language, account.monthTokens) })}
              {` · ${t("usageViews.equivalent", { amount: formatUsd(i18n.language, account.equivalentUsd) })}`}
            </Text>
          </InfoHint>
        ) : (
          <Text variant="small" tone="muted">
            {t("usageViews.monthTokens", { tokens: formatTokensShort(t, i18n.language, account.monthTokens) })}
          </Text>
        )
      ) : null}
    </>
  );
}

/** The account's agents, biggest share first; past the first few, one row that opens the rest in place. */
function AgentShares({ shares, window }: { shares: ReturnType<typeof accountShares>; window: string | null }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const [open, setOpen] = useState(false);
  const percent = (share: number) => (window ? formatPercent(i18n.language, share) : "");
  const tokens = (n: number, now = false) =>
    n > 0 ? formatTokensShort(t, i18n.language, n) : now ? t("usageViews.usesNow") : "";
  const divided = { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth };
  return (
    <View>
      <View style={styles.share}>
        <View style={styles.face} />
        <View style={styles.grow} />
        <Text variant="caption" tone="faint" style={styles.shareNum}>
          {window ?? ""}
        </Text>
        <Text variant="caption" tone="faint" style={styles.shareTokens}>
          {t("usageViews.thisMonth")}
        </Text>
      </View>
      {(open ? [...shares.shown, ...shares.rest] : shares.shown).map((a, i) => (
        <Pressable
          key={a.agentId}
          onPress={() => openAgentUsage(a.agentId)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.share, styles.shareRow, i > 0 && divided, pressed && styles.pressed]}
        >
          <AgentFace agentId={a.agentId} size={18} live={false} />
          <Text variant="small" tone="ink" numberOfLines={1} style={[styles.grow, styles.bold]}>
            {dir.agentById.get(a.agentId)?.name ?? a.name}
          </Text>
          <Text variant="small" tone="ink2" style={styles.shareNum}>
            {percent(a.share)}
          </Text>
          <Text variant="small" tone="muted" style={styles.shareTokens}>
            {tokens(a.tokens, a.now)}
          </Text>
        </Pressable>
      ))}
      {!open && shares.rest.length > 0 ? (
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityState={{ expanded: false }}
          style={({ pressed }) => [styles.share, styles.shareRow, divided, pressed && styles.pressed]}
        >
          <View style={styles.face} />
          <Text variant="small" tone="ink" numberOfLines={1} style={[styles.grow, styles.bold]}>
            {t("usageViews.moreAgents", { count: shares.rest.length })}
          </Text>
          <Text variant="small" tone="ink2" style={styles.shareNum}>
            {percent(shares.restShare)}
          </Text>
          <Text variant="small" tone="muted" style={styles.shareTokens}>
            {tokens(shares.restTokens)}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The API per agent: its tokens, its share of its budget and (with money) what it spent of it. */
function ApiCard({ data }: { data: OrgPlanUsage }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  if (data.api.length === 0) return null;
  return (
    <UsageCard icon="lock" title={t("usageViews.api.title")}>
      <View>
        {data.api.map((a, i) => {
          const name = dir.agentById.get(a.agentId)?.name ?? a.name;
          return (
            <Pressable
              key={a.agentId}
              onPress={() => openAgentUsage(a.agentId)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.api,
                i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth },
                pressed && styles.pressed,
              ]}
            >
              {/* The face on the name's line, the numbers under them at the row's width: never a column beside them. */}
              <MediaRow
                size="row"
                face={<AgentFace agentId={a.agentId} size={MEDIA_ROW.row.face} live={false} />}
                name={name}
              >
                <View>
                  <Text variant="small" tone="muted" style={styles.tabular}>
                    {`${t("usageViews.tokens", { tokens: formatTokensShort(t, i18n.language, a.tokens) })} · ${t("usageViews.budgetShare", { percent: formatPercent(i18n.language, a.budgetPercent) })}`}
                  </Text>
                  {a.costUsd !== undefined && a.budgetUsd !== undefined ? (
                    <Text variant="small" tone="muted" style={styles.tabular}>
                      {t(a.budgetIsDefault ? "settings.usageAgentLineDefault" : "settings.usageAgentLine", {
                        spent: formatUsd(i18n.language, a.costUsd),
                        budget: formatUsd(i18n.language, a.budgetUsd),
                      })}
                    </Text>
                  ) : null}
                </View>
              </MediaRow>
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
  const editable = can(org, "configure");
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
  pressed: { opacity: 0.6 },
  shrink: { flexShrink: 1 },
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8, gap: 14 },
  // The page's own gap, for the cards that fade in together.
  stack: { gap: 14 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  caps: { fontWeight: "700", letterSpacing: 0.5 },
  tabular: { fontVariant: ["tabular-nums"] },
  machine: { gap: 2 },
  machineName: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 2 },
  block: { gap: 12, paddingVertical: 14 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth },
  // An account's agents: face, name, share, tokens, the numbers in right-aligned columns that fit 390 pt.
  share: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32 },
  // The rows that open an agent: a finger's 44 points (the column titles above them stay at 32).
  shareRow: { minHeight: 44 },
  face: { width: 18 },
  shareNum: { minWidth: 44, textAlign: "right", fontVariant: ["tabular-nums"] },
  shareTokens: { minWidth: 68, textAlign: "right", fontVariant: ["tabular-nums"] },
  // Narrower than the web's row: the tokens and the budget's share on one line under the name, the spend under it.
  api: { paddingVertical: 10 },
  kind: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  amount: { minWidth: 64, textAlign: "right" },
  budget: { gap: 6 },
  input: { minHeight: 46, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 10, ...fieldText("body") },
  start: { alignSelf: "flex-start", marginTop: 4 },
});
