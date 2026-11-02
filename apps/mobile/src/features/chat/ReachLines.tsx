import { type Agent, type Message, useChannels, useUpdateAgent } from "@agenteschat/client";
import { audienceWith, canEditAudience, modeOf } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type ReachEntry, reachKey, reachOf, reachOpens } from "@agenteschat/client/lib/reach";
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
  const dir = useDirectory();
  const channel = useChannels(orgId).data?.find((c) => c.id === channelId);
  // A DM isn't in the channel list: "in this conversation".
  const place = channel ? t("reach.inChannel", { name: channel.name }) : t("reach.inHere");
  const agent = dir.agentById.get(e.agentId);
  const g = agentGrammar(agent?.name ?? `@${e.handle}`);
  const handed = Boolean(e.consultationId);
  const runs = boldRuns(t(reachKey(e) as "reach.handed", { ...g, place }) as string);
  const detail = [
    !handed && e.outside ? t("reach.outside", { place }) : null,
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
      {reachOpens(e) ? (
        <PillButton
          label={t("reach.see")}
          accessibilityRole="link"
          onPress={() => {
            tapHaptic();
            if (e.consultationId) router.push(consultationHref(e.consultationId, channelId));
          }}
        />
      ) : null}
      {!handed && agent && e.userId ? <AllowTalkPill agent={agent} userId={e.userId} /> : null}
    </View>
  );
}

/**
 * "Deixar Ana falar com ele": lets `userId` talk to the agent, for its owner and who manages agents, when its
 * audience keeps them out (a routine's creator it couldn't reach). Nothing otherwise.
 */
export function AllowTalkPill({ agent, userId }: { agent: Agent; userId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const me = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const update = useUpdateAgent(orgId, agent.id);
  const person = dir.memberById.get(userId)?.name;
  const audience = audienceWith(agent, userId);
  if (!person || !audience || !me || modeOf(agent) === "everyone" || !canEditAudience(org ?? undefined, agent, me))
    return null;
  const g = agentGrammar(agent.name);
  return (
    <PillButton
      label={t("reach.allow", { person, context: g.context })}
      onPress={() => {
        if (update.isPending || update.isSuccess) return;
        tapHaptic();
        update.mutate(
          { audience },
          { onSuccess: () => toast({ title: t("reach.allowed", { person, name: g.name }) }) },
        );
      }}
    />
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
