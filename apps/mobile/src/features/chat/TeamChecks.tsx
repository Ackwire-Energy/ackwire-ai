import type { Message, TeamCheck } from "@agenteschat/client";
import { targetKind, teamChecksOf } from "@agenteschat/client/lib/team-checks";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Icon, type IconName, RowAction, Text, useTheme } from "@/ui";
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
 * opens that conversation. The receipts' card (Receipts.tsx), its words whole; nothing to undo.
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
  const { colors, shadows } = useTheme();
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
    <View style={[styles.one, { backgroundColor: colors.raised, borderColor: colors.line2 }]}>
      <View style={[styles.tile, { backgroundColor: colors.raised, boxShadow: shadows.e1 }]}>
        <Icon name={ICONS[targetKind(target)]} size={16} color={colors.ink2} />
      </View>
      <View style={[styles.grow, styles.tx]}>
        <Text variant="small" tone="ink2" style={styles.oneText}>
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
          <Text variant="caption" tone="faint" style={styles.detail}>
            {detail}
          </Text>
        ) : null}
      </View>
      {channelId ? (
        <RowAction
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
  // The receipts' card: a hairline, the cut corner; the tile, the first line and the pill share one middle.
  one: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    minHeight: 50,
    paddingVertical: 9,
    paddingLeft: 12,
    paddingRight: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 4,
  },
  tx: { paddingTop: 6 },
  oneText: { fontSize: 14.5, lineHeight: 19 },
  detail: { marginTop: 2 },
  tile: { width: 24, height: 24, marginTop: 4, borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
