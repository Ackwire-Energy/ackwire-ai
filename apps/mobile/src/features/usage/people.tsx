import type { AppNotification, UsagePlace } from "@agenteschat/client";
import { usePeopleUsage, usePersonUsage, useRaisePersonLimit, useRefuseMoreUsage } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatDecimal, formatShortDate, formatUsd, relativeTime } from "@agenteschat/client/lib/format";
import type { PersonRow } from "@agenteschat/client/lib/person-usage";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Text, useToast } from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { Meter, UsageCard } from "./parts";

/*
 * Uso › Pessoas on the phone (ADR 0141), as the web's: each person with their month against their limit and what they
 * do now (who sees money), or one's own month in percentages; and a request for more, answered in Atividade.
 */

const place = (t: TFunction, p: UsagePlace, agent: string) =>
  p.kind === "channel"
    ? t("peopleUsage.now.channel", { agent, channel: p.channelName ?? "" })
    : p.kind === "routine"
      ? t("peopleUsage.now.routine", { name: p.routineName ?? "" })
      : p.kind === "hidden"
        ? t("peopleUsage.now.hidden", { agent })
        : t("peopleUsage.now.private", { agent });

function nowLine(t: TFunction, locale: string, agentName: (id: string) => string, p: PersonRow) {
  if (p.now) return place(t, p.now.place, agentName(p.now.agentId));
  return p.lastActiveAt
    ? t("peopleUsage.now.last", { when: relativeTime(t, locale, p.lastActiveAt) })
    : t("peopleUsage.now.never");
}

/** Who sees money: each person, their month against the limit, and "Agora" as the second line. */
export function PeopleList() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const dir = useDirectory();
  const usage = usePeopleUsage(orgId);
  if (usage.isLoading) return <ActivityIndicator color={c.muted} />;
  if (!usage.data)
    return (
      <Text variant="small" tone="muted">
        {t("common.loadFailed")}
      </Text>
    );
  const data = usage.data;
  const agentName = (id: string) => dir.nameOf({ type: "agent", id });
  const tone = (p: PersonRow) => (p.state === "at" ? c.danger : p.state === "near" ? c.warn : undefined);
  return (
    <UsageCard icon="members" title={t("peopleUsage.title")}>
      {data.people.map((p, i) => (
        <View
          key={p.userId}
          style={[styles.row, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
        >
          <Face who={{ type: "person", id: p.userId }} size={36} live={false} />
          <View style={styles.grow}>
            <View style={styles.line}>
              <Text variant="subhead" tone="ink" numberOfLines={1} style={[styles.grow, styles.bold]}>
                {p.name}
              </Text>
              <Text variant="footnote" tone="ink2" style={styles.tabular}>
                {data.plansOnly
                  ? t("peopleUsage.meter.estimate", { amount: formatUsd(i18n.language, p.monthUsd) })
                  : formatUsd(i18n.language, p.monthUsd)}
                {p.limitUsd === null
                  ? ` ${t("peopleUsage.meter.noLimit")}`
                  : ` ${t("peopleUsage.meter.of", { limit: formatDecimal(i18n.language, p.limitUsd) })}`}
              </Text>
            </View>
            {p.limitUsd !== null ? <Meter value={p.percent ?? 0} label={p.name} mark={80} color={tone(p)} /> : null}
            <Text variant="footnote" tone={p.now ? "ink" : "muted"} numberOfLines={2}>
              {nowLine(t, i18n.language, agentName, p)}
            </Text>
          </View>
        </View>
      ))}
    </UsageCard>
  );
}

/** Seu uso: one's own month, in percentages of the limit (never money). */
export function MyUsageCard() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const dir = useDirectory();
  const usage = usePersonUsage(orgId, useMeId());
  const data = usage.data;
  if (!data) return usage.isLoading ? <ActivityIndicator color={c.muted} /> : null;
  const l = data.limit;
  const tone = l.state === "at" ? c.danger : l.state === "near" ? c.warn : undefined;
  return (
    <UsageCard
      icon="chart"
      title={
        l.percent === null
          ? t("peopleUsage.mine.noLimit")
          : t("peopleUsage.mine.title", { percent: Math.round(l.percent) })
      }
      footer={t("peopleUsage.mine.renews", { date: formatShortDate(i18n.language, data.renewsAt) })}
    >
      {l.percent !== null ? (
        <Meter value={l.percent} label={`${Math.round(l.percent)}%`} mark={80} color={tone} />
      ) : null}
      {data.agents.map((a) => (
        <View key={a.agentId} style={styles.line}>
          <Face who={{ type: "agent", id: a.agentId }} size={22} live={false} />
          <Text variant="subhead" tone="ink" style={styles.grow}>
            {dir.nameOf({ type: "agent", id: a.agentId })}
          </Text>
          <Text variant="footnote" tone="muted" style={styles.tabular}>
            {t("peopleUsage.mine.ofLimit", { percent: Math.round(a.amount) })}
          </Text>
        </View>
      ))}
    </UsageCard>
  );
}

/** "Aumentar para US$ X este mês" and "Recusar" on a person's request for more (who decides). */
export function UsageLimitActions({ n }: { n: AppNotification }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const raise = useRaisePersonLimit(orgId);
  const refuse = useRefuseMoreUsage(orgId);
  const toast = useToast();
  const userId = n.source.userId;
  const to = n.latest.raiseToUsd;
  if (n.latest.statusTo !== "request" || !userId || n.doneAt) return null;
  const fail = (e: unknown) => toast({ title: errorText(t, e), icon: "x" });
  return (
    <View style={styles.acts}>
      {to !== undefined ? (
        <Button
          variant="primary"
          size="sm"
          loading={raise.isPending}
          label={t("peopleUsage.actions.raise", { amount: formatUsd(i18n.language, to) })}
          onPress={() => raise.mutate([userId, to], { onError: fail })}
        />
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        loading={refuse.isPending}
        label={t("peopleUsage.actions.refuse")}
        onPress={() => refuse.mutate([userId], { onError: fail })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 12 },
  line: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1, minWidth: 0, gap: 6 },
  bold: { fontWeight: "600" },
  tabular: { fontVariant: ["tabular-nums"] },
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
});
