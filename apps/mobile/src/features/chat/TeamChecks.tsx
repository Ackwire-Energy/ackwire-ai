import type { Message, TeamCheck } from "@agenteschat/client";
import { targetKind, teamChecksOf } from "@agenteschat/client/lib/team-checks";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Icon, type IconName, PillButton, Text, useTheme } from "@/ui";
import { agoOf } from "../agents/logic";
import { agoText } from "../agents/work";
import { chatHref } from "../links/logic";
import { tapHaptic } from "../shared/parts";
import { boldRuns } from "./actions";

const ICONS: Record<ReturnType<typeof targetKind>, IconName> = {
  email: "mail",
  phone: "chat",
  code: "code",
  url: "globe",
  other: "reply",
};

/**
 * Team actions (ADR 0064) on the phone: under an agent's reply, what it didn't do because the team
 * already had (the same address, number, page or pull request), whose action it found and Ver, which
 * opens that conversation. The receipts' sunken row (Receipts.tsx); nothing to undo.
 */
export function TeamChecks({ message: m }: { message: Message }) {
  const list = teamChecksOf(m.meta);
  if (m.author.type !== "agent" || list.length === 0) return null;
  return (
    <View style={styles.list}>
      {list.map((c) => (
        <Row key={c.id} check={c} selfId={m.author.id} />
      ))}
    </View>
  );
}

function Row({ check, selfId }: { check: TeamCheck; selfId: string | null }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const match = check.matches[0];
  const target = check.targets[0] ?? "";
  if (!match) return null;
  const when = agoText(t, agoOf(match.at, Date.now()));
  const key = !match.agentId
    ? "teamChecks.someone"
    : match.agentId === selfId
      ? "teamChecks.self"
      : "teamChecks.teammate";
  const runs = boldRuns(t(key as "teamChecks.teammate", { target, when, who: match.agentName ?? "" }) as string);
  const detail = [match.summary, match.channelName ? t("teamChecks.inChannel", { channel: match.channelName }) : null]
    .filter(Boolean)
    .join(" · ");
  const channelId = match.channelId;
  return (
    <View style={[styles.one, { backgroundColor: colors.sunken }]}>
      <View style={[styles.tile, { backgroundColor: colors.raised }]}>
        <Icon name={ICONS[targetKind(target)]} size={14} color={colors.ink2} />
      </View>
      <View style={styles.grow}>
        <Text variant="small" tone="ink2" numberOfLines={2} style={styles.oneText}>
          {runs.map((r, i) =>
            r.bold ? (
              <Text key={String(i)} variant="small" tone="ink" style={[styles.oneText, styles.bold]}>
                {r.text}
              </Text>
            ) : (
              r.text
            ),
          )}
        </Text>
        {detail ? (
          <Text variant="caption" tone="faint" numberOfLines={1} style={styles.detail}>
            {detail}
          </Text>
        ) : null}
      </View>
      {channelId ? (
        <PillButton
          label={t("teamChecks.open")}
          accessibilityRole="link"
          onPress={() => {
            tapHaptic();
            router.push(chatHref(channelId));
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 12, gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  one: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 50,
    paddingVertical: 9,
    paddingLeft: 12,
    paddingRight: 10,
    borderRadius: 16,
  },
  oneText: { fontSize: 14.5, lineHeight: 19 },
  detail: { marginTop: 2 },
  tile: { width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
