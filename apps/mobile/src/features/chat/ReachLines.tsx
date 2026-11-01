import { type Message, useChannels, useUpdateAgent } from "@agenteschat/client";
import { audienceOf, canEditAudience, modeOf } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type ReachEntry, reachByAccess, reachOf } from "@agenteschat/client/lib/reach";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Icon, PillButton, Text, useTheme, useToast } from "@/ui";
import { consultationHref } from "../links/logic";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { boldRuns } from "./actions";

/**
 * On the phone, under an agent's message, every agent it @named that its mention didn't wake (`meta.reach`): one
 * outside the conversation got it by direct message (Ver opens the two agents' conversation), one it couldn't call
 * says why, and the agent's owner can let that person talk to it. The team actions' sunken row (TeamChecks.tsx).
 */
export function ReachLines({ message: m }: { message: Message }) {
  const list = reachOf(m.meta);
  if (m.author.type !== "agent" || list.length === 0) return null;
  return (
    <View style={styles.list}>
      {list.map((e) => (
        <Row key={e.agentId} entry={e} channelId={m.channelId} />
      ))}
    </View>
  );
}

function Row({ entry: e, channelId }: { entry: ReachEntry; channelId: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const orgId = useOrgId();
  const { org } = useOrg();
  const me = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const update = useUpdateAgent(orgId, e.agentId);
  const channel = useChannels(orgId).data?.find((c) => c.id === channelId);
  const place = channel ? `#${channel.name}` : "";
  const agent = dir.agentById.get(e.agentId);
  const g = agentGrammar(t, agent?.name ?? `@${e.handle}`);
  const handed = Boolean(e.consultationId);
  const key = handed ? "reach.handed" : reachByAccess(e) ? "reach.routineRead" : "reach.blocked";
  const runs = boldRuns(t(key as "reach.handed", { ...g, place }) as string);
  const person = e.userId ? dir.memberById.get(e.userId)?.name : undefined;
  const mayAllow =
    !handed &&
    !!agent &&
    !!e.userId &&
    !!person &&
    !!me &&
    modeOf(agent) !== "everyone" &&
    canEditAudience(org ?? undefined, agent, me);
  const detail = [
    !handed && e.outside && place ? t("reach.outside", { place }) : null,
    e.routine ? t("reach.routine", { name: e.routine.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={[styles.one, { backgroundColor: colors.sunken }]}>
      <View style={[styles.tile, { backgroundColor: colors.raised }]}>
        <Icon name={handed ? "chat" : "info"} size={14} color={colors.ink2} />
      </View>
      <View style={styles.grow}>
        <Text variant="small" tone="ink2" numberOfLines={3} style={styles.oneText}>
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
      {handed && e.consultationId ? (
        <PillButton
          label={t("reach.see")}
          accessibilityRole="link"
          onPress={() => {
            tapHaptic();
            if (e.consultationId) router.push(consultationHref(e.consultationId, channelId));
          }}
        />
      ) : null}
      {mayAllow && agent && e.userId ? (
        <PillButton
          label={t("reach.allow", { person, pronoun: g.pronoun })}
          onPress={() => {
            if (update.isPending || update.isSuccess) return;
            tapHaptic();
            const a = audienceOf(agent);
            const userIds = [...new Set([...(a.mode === "people" ? a.userIds : []), e.userId as string])];
            update.mutate(
              { audience: { mode: "people", userIds } },
              { onSuccess: () => toast({ title: t("reach.allowed", { person, name: g.name }) }) },
            );
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
