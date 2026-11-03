import {
  type Agent,
  type ForeignMailbox,
  type Message,
  useChannels,
  useRoles,
  useWidenAudience,
} from "@agenteschat/client";
import {
  audienceNotice,
  audienceWith,
  audienceWithMe,
  canEditAudience,
  mailLossText,
  modeOf,
} from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type ReachEntry, reachKey, reachOf, reachOpens } from "@agenteschat/client/lib/reach";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Icon, PillButton, Text, useTheme, useToast } from "@/ui";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { boldRuns } from "./actions";
import { ConsultPairRow, useConsultById } from "./ConsultGroup";

/**
 * On the phone, under an agent's message, every agent it @named that its mention didn't wake (`meta.reach`): one
 * outside the conversation got it by direct message (the two agents' pair row, opening their conversation), one it couldn't call
 * says why, and the agent's owner can let that person talk to it. The team actions' sunken row (TeamChecks.tsx).
 */
export function ReachLines({ message: m }: { message: Message }) {
  const list = reachOf(m.meta);
  if (m.author.type !== "agent" || list.length === 0) return null;
  return (
    <View style={styles.list}>
      {list.map((e) => (
        <Row key={e.agentId} entry={e} channelId={m.channelId} authorId={m.author.id ?? ""} />
      ))}
    </View>
  );
}

function Row({ entry: e, channelId, authorId }: { entry: ReachEntry; channelId: string; authorId: string }) {
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
  const talk = useConsultById(channelId, reachOpens(e) ? e.consultationId : undefined);
  const runs = boldRuns(t(reachKey(e) as "reach.handed", { ...g, place }) as string);
  const detail = [
    !handed && e.outside ? t("reach.outside", { place }) : null,
    e.routine ? t("reach.routine", { name: e.routine.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Handed to it by direct message: the two agents talking, as the pair row that opens their conversation.
  if (talk) return <ConsultPairRow askerId={authorId} channelId={channelId} items={[talk]} inline />;
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
  const save = useWidenAudience(orgId, agent.id);
  const person = dir.memberById.get(userId)?.name;
  const audience = audienceWith(agent, userId);
  if (!person || !audience || !me || modeOf(agent) === "everyone" || !canEditAudience(org ?? undefined, agent, me))
    return null;
  const g = agentGrammar(agent.name);
  return (
    <PillButton
      label={t("reach.allow", { person, context: g.context })}
      onPress={() => {
        if (save.busy || save.done) return;
        tapHaptic();
        save.widen(audience, askMailLoss(t, agent), () =>
          toast({ title: t("reach.allowed", { person, name: g.name }) }),
        );
      }}
    />
  );
}

/**
 * "Quero falar com ele": who manages agents (or owns it) lets themselves into an agent that keeps them out. Nothing
 * when it answers them already or is on someone else's plan, where only its owner lets more people in.
 */
export function LetMeTalkPill({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const me = useMeId();
  const toast = useToast();
  const save = useWidenAudience(orgId, agent.id);
  const audience = me ? audienceWithMe(org ?? undefined, agent, me) : null;
  if (!audience) return null;
  const g = agentGrammar(agent.name);
  return (
    <PillButton
      label={t("reach.allowMe", g)}
      onPress={() => {
        if (save.busy || save.done) return;
        tapHaptic();
        save.widen(audience, askMailLoss(t, agent), () => toast({ title: t("reach.allowedMe", g) }));
      }}
    />
  );
}

/**
 * In place of the composer, in a conversation with an agent that doesn't answer me (who manages agents opens it): why,
 * and "Quero falar com ele" when I may let myself in.
 */
export function AgentLocked({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const roles = useRoles(useOrgId()).data?.roles;
  const notice = audienceNotice(
    t,
    agent,
    (id) => dir.memberById.get(id)?.name,
    (id) => roles?.find((r) => r.id === id)?.name,
  );
  return (
    <View style={styles.locked}>
      <Text variant="small" tone="muted" style={styles.lockedText}>
        {notice}
      </Text>
      <LetMeTalkPill agent={agent} />
    </View>
  );
}

/** Before a wider audience takes the mailboxes other people gave the agent: whose they are and why, Cancel or Continue. */
const askMailLoss = (t: TFunction, agent: Agent) => (mailboxes: ForeignMailbox[]) =>
  new Promise<boolean>((answer) =>
    Alert.alert(
      t("reach.mailLossTitle"),
      mailLossText(t, agent, mailboxes),
      [
        { text: t("common.cancel"), style: "cancel", onPress: () => answer(false) },
        { text: t("common.continue"), onPress: () => answer(true) },
      ],
      { cancelable: true, onDismiss: () => answer(false) },
    ),
  );

const styles = StyleSheet.create({
  list: { marginTop: 12, gap: 8 },
  locked: { alignItems: "center", gap: 10, paddingVertical: 6 },
  lockedText: { textAlign: "center" },
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
